import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/** Just enough DOM to run public/assets/signup-wizard.js against one form and its password fields. */
class FakeNode {
  childNodes: Array<FakeNode | string> = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  type = "";
  id = "";
  textContent = "";
  listeners = new Map<string, Array<(event: unknown) => void>>();
  after: (node: FakeNode) => void = () => undefined;
  querySelector: (selector: string) => FakeNode | null = () => null;
  querySelectorAll: (selector: string) => FakeNode[] = () => [];
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  append(...nodes: Array<FakeNode | string>): void { this.childNodes.push(...nodes); }
  replaceChildren(...nodes: Array<FakeNode | string>): void { this.childNodes = nodes; }
  text(): string { return this.childNodes.map((node) => typeof node === "string" ? node : node.textContent || node.text()).join(""); }
}

function load(options: { buttons: FakeNode[]; passwordLabels?: string[] }) {
  const form = new FakeNode("form");
  form.querySelector = (selector: string) => selector === 'button:not([type="button"])' ? options.buttons[0] ?? null : null;
  form.querySelectorAll = (selector: string) => selector === '[aria-busy="true"]' ? options.buttons.filter((button) => button.getAttribute("aria-busy") === "true") : [];
  const toggles: FakeNode[] = [];
  const inputs = (options.passwordLabels ?? []).map((label, index) => {
    const input = new FakeNode("input");
    input.id = `pw-${index}`;
    input.type = "password";
    Object.assign(input, { labels: [{ textContent: label }], form, after: (node: FakeNode) => toggles.push(node) });
    return input;
  });
  const windowListeners = new Map<string, () => void>();
  const document = {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { textContent: text }),
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === ".publicform .pwfield input") return inputs;
      if (selector === "form.publicform, .publicform form") return [form];
      if (selector === "form[data-busy]") return form.dataset.busy ? [form] : [];
      return [];
    },
  };
  const setTimeout = vi.fn();
  const code = readFileSync(fileURLToPath(new URL("../public/assets/signup-wizard.js", import.meta.url)), "utf8");
  runInNewContext(code, { document, window: { addEventListener: (type: string, listener: () => void) => windowListeners.set(type, listener) }, Intl, setTimeout, WeakMap });
  const submit = (submitter: FakeNode | null) => {
    const event = { submitter, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of form.listeners.get("submit") ?? []) listener(event);
    return event.defaultPrevented;
  };
  return { form, toggles, submit, setTimeout, pageshow: () => windowListeners.get("pageshow")!() };
}

function button(label: string, name?: string): FakeNode {
  const element = new FakeNode("button");
  element.append(label);
  if (name) element.setAttribute("name", name);
  return element;
}

describe("public form script", () => {
  it("sends a form once and stays busy until Back, never on a timer, so a slow post can't book or charge twice", () => {
    const slot = button("9:00 AM", "start");
    const page = load({ buttons: [slot] });
    expect(page.submit(slot)).toBe(false);
    expect(slot.text()).toBe("Sending…");
    expect(slot.getAttribute("aria-busy")).toBe("true");
    // The tapped time stays enabled, so its name and value still go with the post.
    expect(slot.getAttribute("disabled")).toBeNull();
    expect(page.setTimeout).not.toHaveBeenCalled();
    expect(page.submit(slot)).toBe(true);
    // Back from the next page: ready again, with its own label.
    page.pageshow();
    expect(slot.text()).toBe("9:00 AM");
    expect(slot.getAttribute("aria-busy")).toBeNull();
    expect(page.submit(slot)).toBe(false);
  });

  it("a submit with no button to mark doesn't lock the form", () => {
    const page = load({ buttons: [] });
    expect(page.submit(null)).toBe(false);
    expect(page.form.dataset.busy).toBeUndefined();
    expect(page.submit(null)).toBe(false);
  });

  it("each Show button names its own field", () => {
    const page = load({ buttons: [], passwordLabels: ["Password", "New password", "Type it again"] });
    expect(page.toggles.map((toggle) => toggle.text())).toEqual(["Show password", "Show new password", "Show password (type it again)"]);
  });
});
