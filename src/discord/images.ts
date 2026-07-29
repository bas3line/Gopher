import sharp from "sharp";

const width = 1_200;
const height = 675;

export async function renderEngineerCard(input: {
  title: string;
  body: string;
  author: string;
}): Promise<Buffer> {
  const lines = wrapWords(stripMarkdown(input.body), 60).slice(0, 9);
  const title = escapeXml(input.title.slice(0, 70).toUpperCase());
  const author = escapeXml(input.author.slice(0, 80));
  const text = lines
    .map(
      (line, index) =>
        `<tspan x="92" dy="${index === 0 ? 0 : 48}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#071a26"/>
          <stop offset="52%" stop-color="#0c3542"/>
          <stop offset="100%" stop-color="#10131d"/>
        </linearGradient>
        <radialGradient id="glow">
          <stop offset="0%" stop-color="#00add8" stop-opacity=".50"/>
          <stop offset="100%" stop-color="#00add8" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1200" height="675" rx="30" fill="url(#bg)"/>
      <circle cx="1085" cy="75" r="310" fill="url(#glow)"/>
      <path d="M0 590 C220 520 420 690 690 585 C880 512 1030 540 1200 470 L1200 675 L0 675Z"
            fill="#00add8" opacity=".12"/>
      <rect x="66" y="58" width="8" height="559" rx="4" fill="#00add8"/>
      <text x="92" y="118" fill="#67e8f9" font-size="25" font-weight="700"
            font-family="Arial, Helvetica, sans-serif" letter-spacing="4">${title}</text>
      <text x="92" y="205" fill="#f8fafc" font-size="36" font-weight="600"
            font-family="Arial, Helvetica, sans-serif">${text}</text>
      <text x="92" y="610" fill="#94a3b8" font-size="23"
            font-family="Arial, Helvetica, sans-serif">— ${author}</text>
      <g transform="translate(1005 508)">
        <ellipse cx="70" cy="78" rx="72" ry="58" fill="#55c7e6"/>
        <circle cx="45" cy="63" r="13" fill="#fff"/><circle cx="95" cy="63" r="13" fill="#fff"/>
        <circle cx="48" cy="66" r="6" fill="#071a26"/><circle cx="92" cy="66" r="6" fill="#071a26"/>
        <path d="M52 92 Q70 110 89 92" stroke="#071a26" stroke-width="6" fill="none"
              stroke-linecap="round"/>
      </g>
      <text x="970" y="645" fill="#67e8f9" font-size="17" font-weight="700"
            font-family="monospace">GOPHER</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

function wrapWords(input: string, maximum: number): string[] {
  const words = input.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maximum && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/[*_~`>#]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .slice(0, 700);
}

function escapeXml(input: string): string {
  return input.replace(
    /[<>&'"]/g,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[
        character
      ] ?? character,
  );
}
