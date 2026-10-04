import { readFileSync } from "node:fs";
import { marked } from "marked";

function renderMarkdownPage(filePath: string, title: string): string {
  const markdown = readFileSync(filePath, "utf8");
  const body = marked.parse(markdown, { async: false });

  return `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} — The Isle</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <main class="readme">
      ${body}
    </main>
  </body>
</html>
`;
}

export const renderReadmePage = (): string => renderMarkdownPage("README.md", "About");
export const renderCreditsPage = (): string => renderMarkdownPage("CREDITS.md", "Credits");
