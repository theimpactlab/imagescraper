"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Download, ExternalLink, Settings, AlertCircle, CheckCircle2 } from "lucide-react"
import JSZip from "jszip"
import { saveAs } from "file-saver"
import { Slider } from "@/components/ui/slider"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog"
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
}

interface CrawlSettings {
  maxDepth: number
  maxPages: number
  includeExternalDomains: boolean
  delayBetweenRequests: number
}

interface CrawlLog {
  timestamp: Date
  message: string
  type: "info" | "error" | "success"
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
    maxDepth: 2,
    maxPages: 20,
    includeExternalDomains: false,
    delayBetweenRequests: 1000,
  })
  const [currentStats, setCurrentStats] = useState({
    pagesVisited: 0,
    imagesFound: 0,
    currentDepth: 0,
  })
  const [crawlLogs, setCrawlLogs] = useState<CrawlLog[]>([])
  const [recentlyVisitedPages, setRecentlyVisitedPages] = useState<string[]>([])

  // Refs for tracking the crawling state
  const isProcessingRef = useRef(false)
  const loadingRef = useRef(false)
  const queueProcessorTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Update the ref when loading state changes
  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  // Add a log entry
  const addLog = (message: string, type: "info" | "error" | "success", url?: string) => {
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
        return new URL(inputUrl).href
      }

      // Handle protocol-relative URLs
      if (inputUrl.startsWith("//")) {
        const baseUrlObj = new URL(baseUrl)
        return `${baseUrlObj.protocol}${inputUrl}`
      }

      // Handle relative URLs
      return new URL(inputUrl, baseUrl).href
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

  const extractLinks = (html: string, baseUrl: string): string[] => {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, "text/html")
    const linkElements = doc.querySelectorAll("a")

    const links: string[] = []

    linkElements.forEach((link) => {
      const href = link.getAttribute("href")
      if (!href) return

      // Skip anchors, javascript, mailto, etc.
      if (
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:")
      ) {
        return
      }

      const normalizedUrl = normalizeUrl(href, baseUrl)

      if (
        normalizedUrl &&
        ((!crawlSettings.includeExternalDomains && isSameDomain(normalizedUrl, baseUrl)) ||
          crawlSettings.includeExternalDomains)
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
      })
    })

    return extractedImages
  }

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const crawlPage = async (pageUrl: string, depth: number): Promise<void> => {
    if (
      visitedUrls.has(pageUrl) ||
      depth > crawlSettings.maxDepth ||
      currentStats.pagesVisited >= crawlSettings.maxPages ||
      !loadingRef.current
    ) {
      return
    }

    try {
      setStatus(`Crawling page: ${pageUrl} (Depth: ${depth})`)
      addLog(`Crawling page at depth ${depth}`, "info", pageUrl)

      // Add to visited URLs
      const updatedVisited = new Set(visitedUrls)
      updatedVisited.add(pageUrl)
      setVisitedUrls(updatedVisited)

      // Update recently visited pages
      setRecentlyVisitedPages((prev) => {
        const newPages = [pageUrl, ...prev.slice(0, 4)]
        return newPages
      })

      // Update stats
      setCurrentStats((prev) => ({
        ...prev,
        pagesVisited: prev.pagesVisited + 1,
        currentDepth: Math.max(prev.currentDepth, depth),
      }))

      // Update progress
      setProgress((currentStats.pagesVisited / crawlSettings.maxPages) * 100)

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

      // Extract links for next level
      const links = extractLinks(html, pageUrl)
      addLog(`Found ${links.length} links on page`, "info", pageUrl)

      // Add new links to queue
      setUrlQueue((prev) => {
        const newLinks = links.filter((link) => !visitedUrls.has(link) && !prev.includes(link))
        if (newLinks.length > 0) {
          addLog(`Added ${newLinks.length} new links to the queue`, "info")
        }
        return [...prev, ...newLinks]
      })

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

    // If we're already processing, not loading, or the queue is empty, don't continue
    if (isProcessingRef.current || !loadingRef.current || urlQueue.length === 0) {
      return
    }

    try {
      isProcessingRef.current = true

      // Get the next URL from the queue
      const nextUrl = urlQueue[0]

      // Update the queue state
      setUrlQueue((prev) => prev.slice(1))

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

    // Cleanup function to clear any timeouts
    return () => {
      if (queueProcessorTimeoutRef.current) {
        clearTimeout(queueProcessorTimeoutRef.current)
      }
    }
  }, [loading, urlQueue.length])

  // Effect to check if crawling is complete
  useEffect(() => {
    if (loading && urlQueue.length === 0 && !isProcessingRef.current) {
      // If the queue is empty and we're not processing anything, we're done
      const timeoutId = setTimeout(() => {
        if (urlQueue.length === 0) {
          setLoading(false)
          setStatus(`Crawling complete. Found ${images.length} images from ${currentStats.pagesVisited} pages.`)
          addLog(`Crawling complete. Found ${images.length} images from ${currentStats.pagesVisited} pages.`, "success")
        }
      }, 2000) // Wait a bit to make sure no new URLs are being added

      return () => clearTimeout(timeoutId)
    }
  }, [loading, urlQueue.length, isProcessingRef.current, images.length, currentStats.pagesVisited])

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
      setLoading(true)
      setError("")
      setStatus("Starting crawl...")
      setImages([])
      setVisitedUrls(new Set())
      setUrlQueue([url])
      setProgress(0)
      setCurrentStats({
        pagesVisited: 0,
        imagesFound: 0,
        currentDepth: 0,
      })
      setCrawlLogs([])
      setRecentlyVisitedPages([])
      isProcessingRef.current = false

      addLog(`Starting crawl from ${url}`, "info", url)

      // The queue processing will be handled by the useEffect
    } catch (err) {
      setError(`Error: ${err instanceof Error ? err.message : String(err)}`)
      setLoading(false)
      addLog(`Error starting crawl: ${err instanceof Error ? err.message : String(err)}`, "error")
    }
  }

  const stopCrawling = () => {
    setLoading(false)
    setUrlQueue([])
    const message = `Crawling stopped. Found ${images.length} images from ${currentStats.pagesVisited} pages.`
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
    return `/api/image-proxy?url=${encodeURIComponent(originalUrl)}`
  }

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
                  max={5}
                  step={1}
                  onValueChange={(value) => setCrawlSettings({ ...crawlSettings, maxDepth: value[0] })}
                />
                <p className="text-xs text-gray-500">How many links deep to crawl from the starting page</p>
              </div>

              <div className="space-y-2">
                <Label>Maximum Pages: {crawlSettings.maxPages}</Label>
                <Slider
                  value={[crawlSettings.maxPages]}
                  min={5}
                  max={100}
                  step={5}
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

              <div className="flex items-center space-x-2">
                <Switch
                  checked={crawlSettings.includeExternalDomains}
                  onCheckedChange={(checked) => setCrawlSettings({ ...crawlSettings, includeExternalDomains: checked })}
                />
                <Label>Include External Domains</Label>
              </div>
              <p className="text-xs text-gray-500">Follow links to other domains (may increase crawl time)</p>
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
          <Progress value={progress} className="h-2" />
          <div className="flex justify-between text-sm text-gray-500 mt-2">
            <span>
              Pages: {currentStats.pagesVisited}/{crawlSettings.maxPages}
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
                  <span className="font-medium">{images.length} images found</span>
                  <span className="text-gray-500 ml-2">({images.filter((img) => img.selected).length} selected)</span>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => toggleSelectAll(true)} disabled={loading}>
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggleSelectAll(false)} disabled={loading}>
                    Deselect All
                  </Button>
                  <Button
                    onClick={downloadSelected}
                    disabled={loading || images.filter((img) => img.selected).length === 0}
                    size="sm"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Download Selected
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {images.map((image, index) => (
                  <Card key={index} className={`overflow-hidden ${image.selected ? "ring-2 ring-blue-500" : ""}`}>
                    <div className="aspect-square relative bg-gray-100 flex items-center justify-center">
                      <img
                        src={getProxiedImageUrl(image.url) || "/placeholder.svg"}
                        alt={image.filename}
                        className="max-h-full max-w-full object-contain"
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).src = "/abstract-geometric-shapes.png"
                        }}
                      />
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
                    <span
                      className={log.type === "error" ? "text-red-600" : log.type === "success" ? "text-green-600" : ""}
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
