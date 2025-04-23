import { type NextRequest, NextResponse } from "next/server"

export const maxDuration = 30 // Set max duration to 30 seconds

// Helper function to get alternative YouTube thumbnail URLs
function getYouTubeThumbnailUrls(videoId: string): string[] {
  return [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/default.jpg`,
  ]
}

// Helper function to check if a URL is a YouTube thumbnail
function isYouTubeThumbnail(url: string): { isYouTube: boolean; videoId: string | null } {
  try {
    const urlObj = new URL(url)
    if (urlObj.hostname === "img.youtube.com" || urlObj.hostname === "i.ytimg.com") {
      // Extract video ID from path
      const pathParts = urlObj.pathname.split("/")
      const videoIdIndex = pathParts.findIndex((part) => part === "vi")
      if (videoIdIndex !== -1 && pathParts.length > videoIdIndex + 1) {
        return { isYouTube: true, videoId: pathParts[videoIdIndex + 1] }
      }
    }
    return { isYouTube: false, videoId: null }
  } catch (e) {
    return { isYouTube: false, videoId: null }
  }
}

// Helper function to fetch with retry
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options)
      if (response.ok) {
        return response
      }

      // If it's the last attempt and response is not ok, throw an error
      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch after ${maxRetries} retries: ${response.status} ${response.statusText}`)
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // If it's the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError
      }

      // Wait before retrying (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)))
    }
  }

  // This should never be reached due to the throws above, but TypeScript needs it
  throw lastError || new Error("Unknown error in fetchWithRetry")
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url")

  if (!url) {
    return NextResponse.json({ error: "URL parameter is required" }, { status: 400 })
  }

  try {
    // Validate URL
    const parsedUrl = new URL(url)

    // Log the URL being fetched (for debugging)
    console.log(`Fetching image from: ${parsedUrl.toString()}`)

    // Check if it's a YouTube thumbnail
    const { isYouTube, videoId } = isYouTubeThumbnail(url)

    // Check if it's an SVG file based on extension
    const isSvg = parsedUrl.pathname.toLowerCase().endsWith(".svg")

    // Prepare fetch options
    const fetchOptions = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept: isSvg ? "image/svg+xml,*/*;q=0.8" : "image/*,*/*;q=0.8",
        Referer: parsedUrl.origin,
      },
      redirect: "follow" as RequestRedirect,
    }

    // Handle YouTube thumbnails with fallbacks
    if (isYouTube && videoId) {
      console.log(`Detected YouTube thumbnail for video ID: ${videoId}`)

      // Try different thumbnail qualities
      const thumbnailUrls = getYouTubeThumbnailUrls(videoId)
      let response: Response | null = null
      let lastError: Error | null = null

      // Try each thumbnail URL until one works
      for (const thumbnailUrl of thumbnailUrls) {
        try {
          console.log(`Trying YouTube thumbnail: ${thumbnailUrl}`)
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 5000) // Shorter timeout for faster fallback

          response = await fetch(thumbnailUrl, {
            ...fetchOptions,
            signal: controller.signal,
          }).finally(() => clearTimeout(timeoutId))

          if (response.ok) {
            console.log(`Successfully fetched YouTube thumbnail: ${thumbnailUrl}`)
            break
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          console.warn(`Failed to fetch YouTube thumbnail ${thumbnailUrl}: ${lastError.message}`)
        }
      }

      if (!response || !response.ok) {
        throw new Error(`Failed to fetch any YouTube thumbnail for video ID ${videoId}`)
      }

      // Get the content type
      const contentType = response.headers.get("Content-Type") || "image/jpeg"

      // Get the response body as an array buffer
      const arrayBuffer = await response.arrayBuffer()

      // Return the image with appropriate headers
      return new NextResponse(arrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(arrayBuffer.byteLength),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400",
          "X-Proxy-Original-Url": url,
        },
      })
    }

    // For regular images, fetch with retry
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000) // 15 second timeout

    try {
      const response = await fetchWithRetry(
        parsedUrl.toString(),
        {
          ...fetchOptions,
          signal: controller.signal,
        },
        2, // Max 2 retries
      ).finally(() => clearTimeout(timeoutId))

      // Special handling for SVG files
      if (isSvg || response.headers.get("Content-Type")?.includes("svg")) {
        const text = await response.text()

        // Return the SVG with appropriate headers
        return new NextResponse(text, {
          status: 200,
          headers: {
            "Content-Type": "image/svg+xml",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
            "X-Proxy-Original-Url": url,
          },
        })
      }

      // For other image types, get the response body as an array buffer
      const arrayBuffer = await response.arrayBuffer()

      // Return the image with appropriate headers
      return new NextResponse(arrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "image/jpeg",
          "Content-Length": String(arrayBuffer.byteLength),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400",
          "X-Proxy-Original-Url": url,
        },
      })
    } catch (fetchError) {
      throw fetchError
    }
  } catch (error) {
    console.error("Image proxy error:", error)

    // Provide more detailed error information
    const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error)

    // Check for specific error types
    const status = error instanceof TypeError ? 400 : 500
    const isAbortError = error instanceof Error && error.name === "AbortError"

    return NextResponse.json(
      {
        error: `Failed to fetch image: ${errorMessage}`,
        timeout: isAbortError,
        url: url,
      },
      { status },
    )
  }
}
