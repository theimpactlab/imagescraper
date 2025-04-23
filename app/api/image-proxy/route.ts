import { type NextRequest, NextResponse } from "next/server"

export const maxDuration = 30 // Set max duration to 30 seconds

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url")

  if (!url) {
    return NextResponse.json({ error: "URL parameter is required" }, { status: 400 })
  }

  try {
    // Validate URL
    new URL(url)

    // Fetch the image
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      redirect: "follow",
    })

    // Check if the response is valid
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`)
    }

    // Get the response body as an array buffer
    const arrayBuffer = await response.arrayBuffer()

    // Return the image with appropriate headers
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "image/jpeg",
        "Content-Length": response.headers.get("Content-Length") || String(arrayBuffer.byteLength),
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
      },
    })
  } catch (error) {
    console.error("Image proxy error:", error)
    return NextResponse.json(
      { error: `Failed to fetch image: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    )
  }
}
