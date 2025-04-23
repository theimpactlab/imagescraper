"use client"

import { DialogTrigger } from "@/components/ui/dialog"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Download, ExternalLink, Settings, AlertCircle, CheckCircle2, Filter, RefreshCw } from "lucide-react"
import JSZip from "jszip"
import { saveAs } from "file-saver"
import { Slider } from "@/components/ui/slider"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

interface ImageItem {
  url: string
  filename: string
  selected: boolean
  sourceUrl: string
  width?: number
  height?: number
  size?: number
  type?: string
  loadFailed?: boolean
  retryCount?: number
}

interface CrawlSettings {
  maxDepth: number
  maxPages: number
  includeExternalDomains: boolean
  delayBetweenRequests: number
  includeSvgImages: boolean
  maxRetries: number
}

interface CrawlLog {
  timestamp: Date
  message: string
  type: "info" | "error" | "success" | "warning"
  url?: string
}

export default function ImageDownloader() {
  const [url, setUrl] = useState("")
  const [images, setImages] = useState<ImageItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const [progress, setProgress] = useState(0)
  const [visitedUrls, setVisitedUrls] = useState<Set<string>>(new Set())
  const [urlQueue, setUrlQueue] = useState<string[]>([])
  const [crawlSettings, setCrawlSettings] = useState<CrawlSettings>({
    maxDepth: 5,
    maxPages: 100,
    includeExternalDomains: false,
    delayBetweenRequests: 1000,
    includeSvgImages: false,
    maxRetries: 1,
  })
  const [currentStats, setCurrentStats] = useState({
    pagesVisited: 0,
    imagesFound: 0,
    currentDepth: 0,
  })
  const [crawlLogs, setCrawlLogs] = useState<CrawlLog[]>([])
  const [recentlyVisitedPages, setRecentlyVisitedPages] = useState<string[]>([])
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const [imageTypeFilter, setImageTypeFilter] = useState<string | null>(null)

  // Refs for tracking the crawling state
  const isProcessingRef = useRef(false)
  const loadingRef = useRef(false)
  const queueProcessorTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pagesVisitedRef = useRef(0)
  const maxPagesRef = useRef(crawlSettings.maxPages)

  // Use a ref for visited URLs to avoid stale state issues
  const visitedUrlsRef = useRef<Set<string>>(new Set())
  const urlQueueRef = useRef<string[]>([])

  // Update the refs when state changes
  useEffect(() => {
    loadingRef.current = loading

    // If we're not loading, reset the pages visited counter
    if (!loading) {
      pagesVisitedRef.current = 0
      visitedUrlsRef.current = new Set()
      urlQueueRef.current = []
    }
  }, [loading])

  // Update maxPages ref when settings change
  useEffect(() => {
    maxPagesRef.current = crawlSettings.maxPages
  }, [crawlSettings.maxPages])

  // Sync the URL queue ref with state
  useEffect(() => {
    urlQueueRef.current = urlQueue
  }, [urlQueue])

  // Sync the visited URLs ref with state
  useEffect(() => {
    visitedUrlsRef.current = visitedUrls
  }, [visitedUrls])

  // Add a log entry
  const addLog = (message: string, type: "info" | "error" | "success" | "warning", url?: string) => {
    setCrawlLogs((prev) => [
      { timestamp: new Date(), message, type, url },
      ...prev.slice(0, 99), // Keep only the last 100 logs
    ])
  }

  const isValidUrl = (urlString: string): boolean => {
    try {
      new URL(urlString)
      return true
    } catch (e) {
      return false
    }
  }

  const normalizeUrl = (inputUrl: string, baseUrl: string): string => {
    try {
      // Handle absolute URLs
      if (inputUrl.startsWith("http")) {
        const url = new URL(inputUrl)
        // Remove trailing slashes, fragments, and normalize to lowercase for consistent comparison
        return url.origin + url.pathname.replace(/\/$/, "").toLowerCase() + (url.search || "")
      }

      // Handle protocol-relative URLs
      if (inputUrl.startsWith("//")) {
        const baseUrlObj = new URL(baseUrl)
        const url = new URL(`${baseUrlObj.protocol}${inputUrl}`)
        return url.origin + url.pathname.replace(/\/$/, "").toLowerCase() + (url.search || "")
      }

      // Handle relative URLs
      const url = new URL(inputUrl, baseUrl)
      return url.origin + url.pathname.replace(/\/$/, "").toLowerCase() + (url.search || "")
    } catch (e) {
      console.error("Error normalizing URL:", e)
      return ""
    }
  }

  const isSameDomain = (urlA: string, urlB: string): boolean => {
    try {
      const domainA = new URL(urlA).hostname
      const domainB = new URL(urlB).hostname
      return domainA === domainB
    } catch (e) {
      return false
    }
  }

  const getImageType = (url: string): string => {
    try {
      const pathname = new URL(url).pathname.toLowerCase()
      if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "jpeg"
      if (pathname.endsWith(".png")) return "png"
      if (pathname.endsWith(".gif")) return "gif"
      if (pathname.endsWith(".svg")) return "svg"
      if (pathname.endsWith(".webp")) return "webp"
      if (pathname.endsWith(".avif")) return "avif"
      return "unknown"
    } catch (e) {
      return "unknown"
    }
  }

  const isYouTubeThumbnail = (url: string): boolean => {
    try {
      const urlObj = new URL(url)
      return urlObj.hostname === "img.youtube.com" || urlObj.hostname === "i.ytimg.com"
    } catch (e) {
      return false
    }
  }

  const extractLinks = (html: string, baseUrl: string): string[] => {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, "text/html")
    const linkElements = doc.querySelectorAll("a")

    const links: string[] = []
    const seenUrls = new Set<string>()

    linkElements.forEach((link) => {
      const href = link.getAttribute("href")
      if (!href) return

      // Skip anchors, javascript, mailto, etc.
      if (
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href === "/"
      ) {
        return
      }

      const normalizedUrl = normalizeUrl(href, baseUrl)

      // Skip empty URLs and ones we've already seen in this extraction
      if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
        return
      }

      seenUrls.add(normalizedUrl)

      if (
        (!crawlSettings.includeExternalDomains && isSameDomain(normalizedUrl, baseUrl)) ||
        crawlSettings.includeExternalDomains
      ) {
        links.push(normalizedUrl)
      }
    })

    return links
  }

  const extractImagesFromHtml = (html: string, pageUrl: string): ImageItem[] => {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, "text/html")
    const imgElements = doc.querySelectorAll("img")

    const extractedImages: ImageItem[] = []

    imgElements.forEach((img, index) => {
      let imgUrl = img.getAttribute("src") || ""

      // Skip data URLs and empty URLs
      if (!imgUrl || imgUrl.startsWith("data:")) {
        return
      }

      // Convert relative URLs to absolute
      imgUrl = normalizeUrl(imgUrl, pageUrl)

      if (!imgUrl) return

      // Get image type
      const type = getImageType(imgUrl)

      // Skip SVG images if not included in settings
      if (type === "svg" && !crawlSettings.includeSvgImages) {
        return
      }

      // Extract filename from URL
      const urlParts = imgUrl.split("/")
      let filename = urlParts[urlParts.length - 1].split("?")[0]

      // If filename doesn't have an extension, add one
      if (!filename.includes(".")) {
        filename = `image-${pageUrl.replace(/[^a-zA-Z0-9]/g, "-")}-${index + 1}.jpg`
      }

      // Try to get width and height from attributes
      const width = Number.parseInt(img.getAttribute("width") || "0", 10) || undefined
      const height = Number.parseInt(img.getAttribute("height") || "0", 10) || undefined

      extractedImages.push({
        url: imgUrl,
        filename,
        selected: true,
        sourceUrl: pageUrl,
        width,
        height,
        type,
        loadFailed: false,
        retryCount: 0,
      })
    })

    return extractedImages
  }

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const crawlPage = async (pageUrl: string, depth: number): Promise<void> => {
    // Normalize the page URL for consistent checking
    const normalizedPageUrl = normalizeUrl(pageUrl, pageUrl)

    if (!normalizedPageUrl) {
      addLog(`Skipping invalid URL: ${pageUrl}`, "warning")
      return
    }

    // Check if we've reached the maximum number of pages
    if (pagesVisitedRef.current >= maxPagesRef.current) {
      addLog(`Maximum page limit (${maxPagesRef.current}) reached. Stopping crawl.`, "warning")
      setLoading(false)
      return
    }

    // Check if we've already visited this URL using the ref for immediate access
    if (visitedUrlsRef.current.has(normalizedPageUrl)) {
      addLog(`Skipping already visited URL: ${normalizedPageUrl}`, "info")
      return
    }

    // Check other conditions
    if (depth > crawlSettings.maxDepth || !loadingRef.current) {
      return
    }

    try {
      // Add to visited URLs BEFORE processing to prevent duplicate processing
      visitedUrlsRef.current.add(normalizedPageUrl)
      setVisitedUrls(new Set(visitedUrlsRef.current))

      // Increment the pages visited counter
      pagesVisitedRef.current += 1

      setStatus(`Crawling page: ${normalizedPageUrl} (Depth: ${depth})`)
      addLog(`Crawling page at depth ${depth}`, "info", normalizedPageUrl)

      // Update recently visited pages
      setRecentlyVisitedPages((prev) => {
        const newPages = [pageUrl, ...prev.slice(0, 4)]
        return newPages
      })

      // Update stats
      setCurrentStats((prev) => ({
        ...prev,
        pagesVisited: pagesVisitedRef.current,
        currentDepth: Math.max(prev.currentDepth, depth),
      }))

      // Update progress
      setProgress((pagesVisitedRef.current / maxPagesRef.current) * 100)

      // Use our server-side proxy
      const response = await fetch(`/api/proxy?url=${encodeURIComponent(pageUrl)}`)

      if (!response.ok) {
        const errorMsg = `Failed to fetch ${pageUrl}: ${response.statusText}`
        console.error(errorMsg)
        addLog(errorMsg, "error", pageUrl)
        return
      }

      const html = await response.text()
      addLog(`Successfully fetched page content`, "success", pageUrl)

      // Extract images
      const newImages = extractImagesFromHtml(html, pageUrl)
      addLog(`Found ${newImages.length} images on page`, "info", pageUrl)

      // Update images state
      setImages((prevImages) => {
        // Filter out duplicates
        const existingUrls = new Set(prevImages.map((img) => img.url))
        const uniqueNewImages = newImages.filter((img) => !existingUrls.has(img.url))

        setCurrentStats((prev) => ({
          ...prev,
          imagesFound: prev.imagesFound + uniqueNewImages.length,
        }))

        if (uniqueNewImages.length > 0) {
          addLog(`Added ${uniqueNewImages.length} new unique images`, "success")
        }

        return [...prevImages, ...uniqueNewImages]
      })

      // If we're at max depth, don't extract more links
      if (depth >= crawlSettings.maxDepth) {
        addLog(`Reached maximum depth (${depth}), not extracting more links`, "info", pageUrl)
        return
      }

      // Check if we've reached the maximum number of pages again
      if (pagesVisitedRef.current >= maxPagesRef.current) {
        addLog(`Maximum page limit (${maxPagesRef.current}) reached. Not adding more links.`, "warning")
        return
      }

      // Extract links for next level
      const links = extractLinks(html, pageUrl)
      addLog(`Found ${links.length} links on page`, "info", pageUrl)

      // Add new links to queue, but only if we haven't reached the max pages
      const newLinks = links.filter((link) => {
        const normalizedLink = normalizeUrl(link, pageUrl)
        // Check against both the ref and the current queue to avoid race conditions
        return (
          normalizedLink && !visitedUrlsRef.current.has(normalizedLink) && !urlQueueRef.current.includes(normalizedLink)
        )
      })

      if (newLinks.length > 0) {
        addLog(`Adding ${newLinks.length} new links to the queue`, "info")
        setUrlQueue((prev) => {
          const updatedQueue = [...prev, ...newLinks]
          urlQueueRef.current = updatedQueue
          return updatedQueue
        })
      } else {
        addLog(`No new links found to add to the queue`, "info")
      }

      // Wait before next request to avoid overwhelming the server
      await delay(crawlSettings.delayBetweenRequests)
    } catch (err) {
      const errorMsg = `Error crawling ${pageUrl}: ${err instanceof Error ? err.message : String(err)}`
      console.error(errorMsg)
      addLog(errorMsg, "error", pageUrl)
    }
  }

  const processQueue = async () => {
    // Clear any existing timeout
    if (queueProcessorTimeoutRef.current) {
      clearTimeout(queueProcessorTimeoutRef.current)
      queueProcessorTimeoutRef.current = null
    }

    // Check if we've reached the maximum number of pages
    if (pagesVisitedRef.current >= maxPagesRef.current) {
      addLog(`Maximum page limit (${maxPagesRef.current}) reached. Stopping crawl.`, "warning")
      setLoading(false)
      return
    }

    // If we're already processing, not loading, or the queue is empty, don't continue
    if (isProcessingRef.current || !loadingRef.current || urlQueueRef.current.length === 0) {
      return
    }

    try {
      isProcessingRef.current = true

      // Get the next URL from the queue
      const nextUrl = urlQueueRef.current[0]

      // Remove it from the queue immediately to prevent reprocessing
      const updatedQueue = urlQueueRef.current.slice(1)
      urlQueueRef.current = updatedQueue
      setUrlQueue(updatedQueue)

      // Debug log to see what URL we're processing
      addLog(`Processing next URL from queue: ${nextUrl}`, "info")

      // Check if we've already visited this URL using the ref
      const normalizedUrl = normalizeUrl(nextUrl, nextUrl)
      if (visitedUrlsRef.current.has(normalizedUrl)) {
        addLog(`Skipping already visited URL: ${nextUrl}`, "info")

        // Important: Release the processing lock and continue with the next URL
        isProcessingRef.current = false

        // Use setTimeout to avoid stack overflow with recursive calls
        queueProcessorTimeoutRef.current = setTimeout(processQueue, 0)
        return
      }

      // Calculate current depth based on the starting URL
      const baseUrlObj = new URL(url)
      const nextUrlObj = new URL(nextUrl)

      // Simple depth calculation - count additional path segments
      const basePath = baseUrlObj.pathname.split("/").filter(Boolean)
      const nextPath = nextUrlObj.pathname.split("/").filter(Boolean)
      const depth = Math.max(1, nextPath.length - basePath.length + 1)

      // Process the URL
      await crawlPage(nextUrl, depth)

      // Schedule the next queue processing
      queueProcessorTimeoutRef.current = setTimeout(() => {
        isProcessingRef.current = false
        processQueue()
      }, 100)
    } catch (error) {
      console.error("Error in queue processing:", error)
      addLog(`Queue processing error: ${error instanceof Error ? error.message : String(error)}`, "error")
      isProcessingRef.current = false

      // Try to continue processing after an error
      queueProcessorTimeoutRef.current = setTimeout(processQueue, 1000)
    }
  }

  // Effect to monitor the queue and start processing when needed
  useEffect(() => {
    if (loading && urlQueue.length > 0 && !isProcessingRef.current) {
      processQueue()
    }

    // Add a safety check to detect if we're stuck in a loop with the same URL
    if (loading && urlQueue.length > 0) {
      // Check if there are duplicate URLs in the queue
      const uniqueUrls = new Set(urlQueue)

      // If we have significantly fewer unique URLs than total URLs, we might be in a loop
      if (uniqueUrls.size < urlQueue.length / 2 && urlQueue.length > 10) {
        addLog(
          `Detected potential queue loop. Queue has ${urlQueue.length} URLs but only ${uniqueUrls.size} unique URLs.`,
          "warning",
        )

        // Filter the queue to only contain unique URLs
        const uniqueUrlArray = Array.from(uniqueUrls)
        urlQueueRef.current = uniqueUrlArray
        setUrlQueue(uniqueUrlArray)
        addLog(`Cleaned queue to contain only unique URLs.`, "info")
      }

      // Also check for the specific case where the same URL appears multiple times in a row
      const allSameUrl = urlQueue.length > 5 && urlQueue.every((queuedUrl) => queuedUrl === urlQueue[0])
      if (allSameUrl) {
        addLog(`Detected queue loop with URL: ${urlQueue[0]}. Clearing queue.`, "warning")
        urlQueueRef.current = []
        setUrlQueue([])
      }
    }

    // Cleanup function to clear any timeouts
    return () => {
      if (queueProcessorTimeoutRef.current) {
        clearTimeout(queueProcessorTimeoutRef.current)
      }
    }
  }, [loading, urlQueue])

  // Effect to check if crawling is complete
  useEffect(() => {
    if (loading && urlQueue.length === 0 && !isProcessingRef.current) {
      // If the queue is empty and we're not processing anything, we're done
      const timeoutId = setTimeout(() => {
        if (urlQueue.length === 0) {
          setLoading(false)
          setStatus(`Crawling complete. Found ${images.length} images from ${pagesVisitedRef.current} pages.`)
          addLog(`Crawling complete. Found ${images.length} images from ${pagesVisitedRef.current} pages.`, "success")
        }
      }, 2000) // Wait a bit to make sure no new URLs are being added

      return () => clearTimeout(timeoutId)
    }
  }, [loading, urlQueue.length, isProcessingRef.current, images.length])

  const startCrawling = async () => {
    if (!url) {
      setError("Please enter a URL")
      return
    }

    if (!isValidUrl(url)) {
      setError("Please enter a valid URL")
      return
    }

    try {
      // Normalize the starting URL
      const normalizedStartUrl = normalizeUrl(url, url)

      // Reset all state
      setLoading(true)
      setError("")
      setStatus("Starting crawl...")
      setImages([])
      setFailedImages(new Set())

      // Reset refs
      isProcessingRef.current = false
      pagesVisitedRef.current = 0
      maxPagesRef.current = crawlSettings.maxPages
      visitedUrlsRef.current = new Set()
      urlQueueRef.current = []

      // Create a new visited URLs set with the normalized start URL
      visitedUrlsRef.current = new Set()
      setVisitedUrls(new Set())

      // Add the normalized URL to the queue
      urlQueueRef.current = [normalizedStartUrl]
      setUrlQueue([normalizedStartUrl])

      setProgress(0)
      setCurrentStats({
        pagesVisited: 0,
        imagesFound: 0,
        currentDepth: 0,
      })
      setCrawlLogs([])
      setRecentlyVisitedPages([])

      addLog(`Starting crawl from ${normalizedStartUrl}`, "info", normalizedStartUrl)
      addLog(`Maximum pages set to ${maxPagesRef.current}`, "info")

      // The queue processing will be handled by the useEffect
    } catch (err) {
      setError(`Error: ${err instanceof Error ? err.message : String(err)}`)
      setLoading(false)
      addLog(`Error starting crawl: ${err instanceof Error ? err.message : String(err)}`, "error")
    }
  }

  const stopCrawling = () => {
    setLoading(false)
    urlQueueRef.current = []
    setUrlQueue([])
    const message = `Crawling stopped. Found ${images.length} images from ${pagesVisitedRef.current} pages.`
    setStatus(message)
    addLog(message, "info")

    // Clear any timeouts
    if (queueProcessorTimeoutRef.current) {
      clearTimeout(queueProcessorTimeoutRef.current)
      queueProcessorTimeoutRef.current = null
    }
  }

  const toggleSelectAll = (select: boolean) => {
    setImages(images.map((img) => ({ ...img, selected: select })))
  }

  const toggleSelect = (index: number) => {
    const updatedImages = [...images]
    updatedImages[index].selected = !updatedImages[index].selected
    setImages(updatedImages)
  }

  const downloadSelected = async () => {
    const selectedImages = images.filter((img) => img.selected)

    if (selectedImages.length === 0) {
      setError("No images selected")
      return
    }

    try {
      setLoading(true)
      setStatus("Preparing download...")
      addLog(`Preparing to download ${selectedImages.length} images`, "info")

      if (selectedImages.length === 1) {
        // Download single image using our server-side proxy
        const proxyUrl = `/api/image-proxy?url=${encodeURIComponent(selectedImages[0].url)}`
        const link = document.createElement("a")
        link.href = proxyUrl
        link.download = selectedImages[0].filename
        link.click()
        addLog(`Downloaded single image: ${selectedImages[0].filename}`, "success")
      } else {
        // Create a zip file for multiple images
        setStatus("Creating zip file...")
        addLog(`Creating zip file for ${selectedImages.length} images`, "info")
        const zip = new JSZip()

        // Add each image to the zip using our server-side proxy
        const fetchPromises = selectedImages.map(async (img, index) => {
          try {
            const proxyUrl = `/api/image-proxy?url=${encodeURIComponent(img.url)}`
            const response = await fetch(proxyUrl)
            if (!response.ok) {
              addLog(`Failed to fetch image: ${img.url}`, "error")
              throw new Error(`Failed to fetch ${img.url}`)
            }

            const blob = await response.blob()
            zip.file(img.filename, blob)

            setStatus(`Adding image ${index + 1}/${selectedImages.length}...`)
            addLog(`Added image ${index + 1}/${selectedImages.length} to zip`, "info")
          } catch (err) {
            console.error(`Error downloading ${img.url}:`, err)
            addLog(`Error downloading ${img.url}: ${err instanceof Error ? err.message : String(err)}`, "error")
          }
        })

        await Promise.all(fetchPromises)

        setStatus("Generating zip file...")
        addLog(`Generating zip file`, "info")
        const content = await zip.generateAsync({ type: "blob" })
        saveAs(content, "website-images.zip")
        addLog(`Zip file generated and download started`, "success")
      }

      setStatus(`Downloaded ${selectedImages.length} images`)
    } catch (err) {
      const errorMsg = `Error: ${err instanceof Error ? err.message : String(err)}`
      setError(errorMsg)
      addLog(errorMsg, "error")
    } finally {
      setLoading(false)
    }
  }

  // Function to get proxied image URL for display
  const getProxiedImageUrl = (originalUrl: string) => {
    // Make sure the URL is properly encoded
    try {
      // Validate the URL first
      new URL(originalUrl)
      return `/api/image-proxy?url=${encodeURIComponent(originalUrl)}`
    } catch (e) {
      console.error("Invalid image URL:", originalUrl)
      return "/abstract-geometric-shapes.png" // Fallback to default image
    }
  }

  // Handle image load error
  const handleImageError = (url: string, index: number) => {
    console.error(`Failed to load image: ${url}`)

    // Add to failed images set
    setFailedImages((prev) => {
      const updated = new Set(prev)
      updated.add(url)
      return updated
    })

    // Update the image item to mark it as failed
    setImages((prevImages) => {
      const updatedImages = [...prevImages]
      if (updatedImages[index]) {
        updatedImages[index] = {
          ...updatedImages[index],
          loadFailed: true,
        }
      }
      return updatedImages
    })

    addLog(`Failed to load image: ${url}`, "error")
  }

  // Retry loading a failed image
  const retryImage = (index: number) => {
    const image = images[index]
    if (!image) return

    setImages((prevImages) => {
      const updatedImages = [...prevImages]
      updatedImages[index] = {
        ...updatedImages[index],
        loadFailed: false,
        retryCount: (updatedImages[index].retryCount || 0) + 1,
      }
      return updatedImages
    })

    // Remove from failed images set
    setFailedImages((prev) => {
      const updated = new Set(prev)
      updated.delete(image.url)
      return updated
    })

    addLog(`Retrying image: ${image.url}`, "info")
  }

  // Filter images by type
  const filterImages = () => {
    if (!imageTypeFilter) return images

    return images.filter((img) => {
      // Filter by type if specified
      if (imageTypeFilter && img.type !== imageTypeFilter) {
        return false
      }
      return true
    })
  }

  const filteredImages = filterImages()

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex gap-2 mb-6">
        <Input
          type="url"
          placeholder="Enter website URL (e.g., https://example.com)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1"
          disabled={loading}
        />

        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" disabled={loading}>
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Crawler Settings</DialogTitle>
              <DialogDescription>Configure how the crawler will navigate through the website</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Maximum Crawl Depth: {crawlSettings.maxDepth}</Label>
                <Slider
                  value={[crawlSettings.maxDepth]}
                  min={1}
                  max={10}
                  step={1}
                  onValueChange={(value) => setCrawlSettings({ ...crawlSettings, maxDepth: value[0] })}
                />
                <p className="text-xs text-gray-500">How many links deep to crawl from the starting page</p>
              </div>

              <div className="space-y-2">
                <Label>Maximum Pages: {crawlSettings.maxPages}</Label>
                <Slider
                  value={[crawlSettings.maxPages]}
                  min={10}
                  max={500}
                  step={10}
                  onValueChange={(value) => setCrawlSettings({ ...crawlSettings, maxPages: value[0] })}
                />
                <p className="text-xs text-gray-500">Maximum number of pages to visit</p>
              </div>

              <div className="space-y-2">
                <Label>Delay Between Requests (ms): {crawlSettings.delayBetweenRequests}</Label>
                <Slider
                  value={[crawlSettings.delayBetweenRequests]}
                  min={500}
                  max={3000}
                  step={100}
                  onValueChange={(value) => setCrawlSettings({ ...crawlSettings, delayBetweenRequests: value[0] })}
                />
                <p className="text-xs text-gray-500">Time to wait between page requests</p>
              </div>

              <div className="space-y-2">
                <Label>Maximum Retries: {crawlSettings.maxRetries}</Label>
                <Slider
                  value={[crawlSettings.maxRetries]}
                  min={0}
                  max={5}
                  step={1}
                  onValueChange={(value) => setCrawlSettings({ ...crawlSettings, maxRetries: value[0] })}
                />
                <p className="text-xs text-gray-500">Number of times to retry loading failed images</p>
              </div>

              <div className="flex items-center space-x-2">
                <Switch
                  checked={crawlSettings.includeExternalDomains}
                  onCheckedChange={(checked) => setCrawlSettings({ ...crawlSettings, includeExternalDomains: checked })}
                />
                <Label>Include External Domains</Label>
              </div>
              <p className="text-xs text-gray-500">Follow links to other domains (may increase crawl time)</p>

              <div className="flex items-center space-x-2">
                <Switch
                  checked={crawlSettings.includeSvgImages}
                  onCheckedChange={(checked) => setCrawlSettings({ ...crawlSettings, includeSvgImages: checked })}
                />
                <Label>Include SVG Images</Label>
              </div>
              <p className="text-xs text-gray-500">
                Include SVG vector graphics in results (may cause errors with some sites)
              </p>
            </div>
          </DialogContent>
        </Dialog>

        {loading ? (
          <Button variant="destructive" onClick={stopCrawling}>
            Stop Crawling
          </Button>
        ) : (
          <Button onClick={startCrawling}>Start Crawling</Button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 flex items-start">
          <AlertCircle className="h-5 w-5 mr-2 mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {status && <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded mb-4">{status}</div>}

      {loading && (
        <div className="mb-4">
          <div className="flex justify-between mb-2">
            <span>Crawling Progress</span>
            <span>{Math.min(100, Math.round(progress))}%</span>
          </div>
          <Progress value={Math.min(100, progress)} className="h-2" />
          <div className="flex justify-between text-sm text-gray-500 mt-2">
            <span>
              Pages: {pagesVisitedRef.current}/{maxPagesRef.current}
            </span>
            <span>Images: {currentStats.imagesFound}</span>
            <span>
              Depth: {currentStats.currentDepth}/{crawlSettings.maxDepth}
            </span>
          </div>

          {recentlyVisitedPages.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium mb-2">Recently Visited Pages:</h3>
              <div className="flex flex-wrap gap-2">
                {recentlyVisitedPages.map((page, index) => (
                  <TooltipProvider key={index}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="text-xs truncate max-w-[200px]">
                          {new URL(page).pathname || "/"}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">{page}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4">
            <h3 className="text-sm font-medium mb-2">Queue Status:</h3>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{urlQueue.length} URLs in queue</Badge>
              {isProcessingRef.current && <Badge variant="outline">Processing...</Badge>}
            </div>
          </div>
        </div>
      )}

      <Tabs defaultValue="images" className="mb-6">
        <TabsList>
          <TabsTrigger value="images">Images ({images.length})</TabsTrigger>
          <TabsTrigger value="logs">Activity Log ({crawlLogs.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="images">
          {images.length > 0 && (
            <>
              <div className="flex justify-between items-center mb-4">
                <div>
                  <span className="font-medium">{filteredImages.length} images found</span>
                  <span className="text-gray-500 ml-2">
                    ({filteredImages.filter((img) => img.selected).length} selected)
                  </span>
                </div>
                <div className="flex gap-2">
                  <div className="flex items-center gap-2 mr-4">
                    <Button variant="outline" size="sm" className="flex items-center gap-1">
                      <Filter className="h-4 w-4" />
                      <select
                        className="bg-transparent border-none focus:outline-none text-sm"
                        onChange={(e) => {
                          setImageTypeFilter(e.target.value === "all" ? null : e.target.value)
                        }}
                        value={imageTypeFilter || "all"}
                      >
                        <option value="all">All Types</option>
                        <option value="jpeg">JPEG</option>
                        <option value="png">PNG</option>
                        <option value="gif">GIF</option>
                        <option value="svg">SVG</option>
                        <option value="webp">WebP</option>
                      </select>
                    </Button>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => toggleSelectAll(true)} disabled={loading}>
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggleSelectAll(false)} disabled={loading}>
                    Deselect All
                  </Button>
                  <Button
                    onClick={downloadSelected}
                    disabled={loading || filteredImages.filter((img) => img.selected).length === 0}
                    size="sm"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Download Selected
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {filteredImages.map((image, index) => (
                  <Card key={index} className={`overflow-hidden ${image.selected ? "ring-2 ring-blue-500" : ""}`}>
                    <div className="aspect-square relative bg-gray-100 flex items-center justify-center">
                      {image.loadFailed ? (
                        <div className="flex flex-col items-center justify-center p-4">
                          <AlertCircle className="h-8 w-8 text-red-500 mb-2" />
                          <p className="text-xs text-center text-gray-500 mb-2">Failed to load image</p>
                          {(image.retryCount || 0) < crawlSettings.maxRetries && (
                            <Button variant="outline" size="sm" onClick={() => retryImage(index)} className="text-xs">
                              <RefreshCw className="h-3 w-3 mr-1" />
                              Retry
                            </Button>
                          )}
                        </div>
                      ) : (
                        <img
                          src={getProxiedImageUrl(image.url) || "/abstract-geometric-shapes.png"}
                          alt={image.filename}
                          className="max-h-full max-w-full object-contain"
                          onError={(e) => {
                            handleImageError(image.url, index)
                            ;(e.target as HTMLImageElement).src = "/abstract-geometric-shapes.png"
                            ;(e.target as HTMLImageElement).dataset.loadFailed = "true"
                          }}
                        />
                      )}
                      {image.type && (
                        <Badge variant="secondary" className="absolute top-2 right-2 text-xs">
                          {image.type.toUpperCase()}
                        </Badge>
                      )}
                      {isYouTubeThumbnail(image.url) && (
                        <Badge variant="outline" className="absolute top-2 left-2 text-xs bg-red-50">
                          YouTube
                        </Badge>
                      )}
                    </div>
                    <div className="p-2">
                      <div className="text-xs text-gray-500 truncate" title={image.filename}>
                        {image.filename}
                      </div>
                      <div className="text-xs text-gray-400 truncate mt-1" title={image.sourceUrl}>
                        From: {image.sourceUrl}
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => window.open(getProxiedImageUrl(image.url), "_blank")}
                        >
                          <ExternalLink className="h-4 w-4" />
                          <span className="sr-only">Open image</span>
                        </Button>
                        <input
                          type="checkbox"
                          checked={image.selected}
                          onChange={() => toggleSelect(index)}
                          className="h-4 w-4"
                        />
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )}
        </TabsContent>
        <TabsContent value="logs">
          <ScrollArea className="h-[300px] border rounded-md p-4">
            {crawlLogs.length === 0 ? (
              <div className="text-center text-gray-500 py-8">No activity logs yet</div>
            ) : (
              <div className="space-y-2">
                {crawlLogs.map((log, index) => (
                  <div key={index} className="text-sm flex items-start gap-2">
                    <span className="text-gray-500 whitespace-nowrap">{log.timestamp.toLocaleTimeString()}</span>
                    {log.type === "error" && <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />}
                    {log.type === "success" && <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />}
                    {log.type === "warning" && <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />}
                    <span
                      className={
                        log.type === "error"
                          ? "text-red-600"
                          : log.type === "success"
                            ? "text-green-600"
                            : log.type === "warning"
                              ? "text-amber-600"
                              : ""
                      }
                    >
                      {log.message}
                    </span>
                    {log.url && (
                      <span className="text-xs text-gray-500 truncate max-w-[200px]">
                        ({new URL(log.url).pathname || "/"})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}
