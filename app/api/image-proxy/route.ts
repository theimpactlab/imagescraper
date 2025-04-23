import { type NextRequest, NextResponse } from "next/server"

export const maxDuration = 30 // Set max duration to 30 seconds

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

    // Fetch the image with improved error handling and timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000) // 15 second timeout

    const response = await fetch(parsedUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept: "image/*,*/*;q=0.8",
        Referer: parsedUrl.origin,
      },
      redirect: "follow",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId))

    // Check if the response is valid
    if (!response.ok) {
      console.error(`Failed to fetch image: ${response.status} ${response.statusText}`)
      return NextResponse.json(
        {
          error: `Failed to fetch image: ${response.status} ${response.statusText}`,
        },
        { status: response.status },
      )
    }

    // Check if the content type is an image
    const contentType = response.headers.get("Content-Type") || ""
    if (!contentType.startsWith("image/")) {
      console.warn(`Resource is not an image: ${contentType}`)
      // We'll still try to return it, but log a warning
    }

    // Get the response body as an array buffer
    const arrayBuffer = await response.arrayBuffer()

    // Return the image with appropriate headers
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType || "image/jpeg",
        "Content-Length": String(arrayBuffer.byteLength),
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
        "X-Proxy-Original-Url": url,
      },
    })
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
