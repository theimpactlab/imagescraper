export type CrawlLog = {
  timestamp: Date
  message: string
  type: "info" | "error" | "success" | "warning"
  url?: string
}
