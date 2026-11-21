export const escapeRe = /^(\s+\$\d+)\s+ESCAPE\s+'\\'(?=\s*(?:\)|AND\b|OR\b|;|$))/i
export const deleteRe = /^\s+\$(\d+)\s+ESCAPE\s+'\\'(?=\s*(?:\)|AND\b|OR\b|;|$))/i
export const columnRe =
  /("(?:[^"]|"")*"(?:\."(?:[^"]|"")*")?|[a-z_][\w$]*(?:\.[a-z_][\w$]*)?)\s*$/i
