import { ChevronRight, Image as ImageIcon } from 'lucide-react'

// Collapsible screenshot for docs pages. Authored in markdown as a fenced block:
//
//   ```screenshot
//   src: /docs/screenshots/inbox.webp
//   alt: The inbox for a team with four agents
//   width: 1309
//   height: 688
//   ```
//
// Collapsed by default so the page leads with text; the image is lazy-loaded when expanded.
export function parseScreenshotSpec(spec: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of spec.split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return fields
}

export default function DocScreenshot({ spec }: { spec: string }) {
  const { src, alt = 'Screenshot', width, height } = parseScreenshotSpec(spec)
  if (!src) return null
  return (
    <details className="not-prose group my-6 rounded-lg border bg-muted/30 open:bg-background">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
        <ImageIcon className="h-4 w-4 shrink-0" />
        <span>Screenshot: {alt}</span>
      </summary>
      <figure className="border-t px-4 pb-4 pt-3">
        <img
          src={src}
          alt={alt}
          width={width ? Number(width) : undefined}
          height={height ? Number(height) : undefined}
          loading="lazy"
          decoding="async"
          className="h-auto w-full rounded-md border"
        />
        <figcaption className="mt-2 text-xs text-muted-foreground">Sample workspace</figcaption>
      </figure>
    </details>
  )
}
