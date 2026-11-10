/** Markup that is already escaped. Only `html` and `raw` create it. */
export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

export type HtmlValue = SafeHtml | string | number | readonly SafeHtml[];

const ESCAPES = new Map([
  ['"', "&quot;"],
  ["&", "&amp;"],
  ["'", "&#39;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

export const escapeHtml = (text: string): string =>
  text.replaceAll(/["&'<>]/gu, (ch) => ESCAPES.get(ch) ?? ch);

const render = (value: HtmlValue): string => {
  if (value instanceof SafeHtml) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map((item: SafeHtml) => item.value).join("");
  }
  return escapeHtml(String(value));
};

/** A template tag that escapes every interpolated value unless it is SafeHtml. */
export const html = (
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): SafeHtml =>
  new SafeHtml(
    strings.reduce(
      (out, part, index) =>
        out + part + (index < values.length ? render(values[index] ?? "") : ""),
      ""
    )
  );
