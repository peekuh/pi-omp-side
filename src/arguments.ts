export interface SideArguments {
  prompt: string;
  name?: string;
}

export const MAX_NAME_LENGTH = 80;

export function validateName(name: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new Error("The side name cannot contain control characters.");
  const value = name.trim();
  if (!value) throw new Error("The side name cannot be empty.");
  if ([...value].length > MAX_NAME_LENGTH) throw new Error(`The side name exceeds ${MAX_NAME_LENGTH} characters.`);
  return value;
}

/** Read only the name argument. The prompt must never be shell-tokenized or evaluated. */
function readName(input: string): { value: string; rest: string } {
  let value = "";
  let quote = "";
  let index = 0;
  for (; index < input.length; index++) {
    const char = input[index];
    if (!quote && /\s/u.test(char)) break;
    if (char === "\\" && quote !== "'") {
      const next = input[index + 1];
      if (next === undefined) throw new Error("The side name ends with an incomplete escape.");
      // Inside double quotes, retain backslashes except before a quote or backslash.
      if (quote === '"' && next !== '"' && next !== "\\") value += char;
      else { value += next; index++; }
    } else if (quote && char === quote) quote = "";
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else value += char;
  }
  if (quote) throw new Error("The side name has an unterminated quote.");
  return { value: validateName(value), rest: input.slice(index).trimStart() };
}

/** Options precede the prompt; -- makes any following option-like text literal. */
export function parseSideArguments(args: string): SideArguments {
  let rest = args.trim();
  let name: string | undefined;
  while (rest) {
    if (/^--(?:\s|$)/u.test(rest)) return { name, prompt: rest.slice(2).trim() };
    const flag = /^--name(?:=|\s|$)/u.exec(rest);
    if (!flag) break;
    if (name !== undefined) throw new Error("Pass --name only once.");
    const input = rest.slice(flag[0].length).trimStart();
    if (!input || (!flag[0].endsWith("=") && input.startsWith("--"))) {
      throw new Error('Missing --name value. Usage: /side --name "Task label" [prompt]');
    }
    const parsed = readName(input);
    name = parsed.value;
    rest = parsed.rest;
  }
  return { name, prompt: rest };
}
