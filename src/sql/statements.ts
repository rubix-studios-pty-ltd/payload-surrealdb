const quoted =
  /[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$(?:[a-zA-Z_]\w*)?\$)[\s\S]*?\1|--[^\r\n]*|\/\*[\s\S]*?\*\//

export const tokens = new RegExp(`${quoted.source}|;`, 'g')
export const words = new RegExp(`${quoted.source}|([a-zA-Z_][\\w$]*)`, 'g')
