import ImageDownloader from "@/components/image-downloader"

export default function Home() {
  return (
    <main className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6 text-center">Website Image Downloader</h1>
      <p className="text-gray-600 mb-8 text-center max-w-2xl mx-auto">
        Enter a website URL to extract and download images. Note: Due to browser security restrictions, this tool works
        best with websites that don't have CORS restrictions.
      </p>
      <ImageDownloader />
    </main>
  )
}
