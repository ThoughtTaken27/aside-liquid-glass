/** Parse HTML structurally; replace known CDN libraries with local, locked builds. */
import fs from 'node:fs';
import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { FRAME_SCRIPT } from './visual-runtime.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type Parent = DefaultTreeAdapterMap['parentNode'];
export type VisualLibrary = 'chart' | 'd3' | 'three' | 'three-global' | 'orbit-controls';
const cached = new Map<VisualLibrary, string>();
const VENDOR_ROOT = new URL('../dist/visual-vendor/', import.meta.url);
const escapeScript = (source: string) => source.replace(/<\/script/gi, '<\\/script');

export function visualLibrary(url: string): VisualLibrary | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null;
  const path = u.pathname;
  if (u.hostname === 'cdn.jsdelivr.net' || u.hostname === 'unpkg.com') {
    const p = u.hostname === 'cdn.jsdelivr.net' ? path.replace(/^\/npm\//, '/') : path;
    if (/^\/chart\.js(?:@4(?:\.\d+){0,2})?(?:\/dist\/chart\.umd(?:\.min)?\.js)?$/.test(p)) return 'chart';
    if (/^\/d3(?:@7(?:\.\d+){0,2})?(?:\/dist\/d3(?:\.min)?\.js)?$/.test(p)) return 'd3';
    if (/^\/three@0\.170\.0\/(?:build\/three\.module(?:\.min)?\.js|\+esm)$/.test(p)) return 'three';
    if (/^\/three@0\.170\.0\/build\/three(?:\.min)?\.js$/.test(p)) return 'three-global';
    if (/^\/three@0\.170\.0\/(?:examples\/jsm|addons)\/controls\/OrbitControls\.js$/.test(p)) return 'orbit-controls';
  }
  if (u.hostname === 'd3js.org' && /^\/d3\.v7(?:\.min)?\.js$/.test(path)) return 'd3';
  if (u.hostname === 'cdnjs.cloudflare.com' && /^\/ajax\/libs\/Chart\.js\/4\.\d+\.\d+\/chart\.umd(?:\.min)?\.js$/.test(path)) return 'chart';
  return null;
}

export function visualLibrarySource(name: VisualLibrary): string {
  let value = cached.get(name);
  if (value === undefined) {
    value = fs.readFileSync(new URL(name + '.js', VENDOR_ROOT), 'utf8');
    cached.set(name, value);
  }
  return value;
}

function isParent(node: Node): node is Parent { return 'childNodes' in node; }
function isElement(node: Node): node is Element { return 'tagName' in node; }
function textOf(node: Parent): string { return node.childNodes.filter(n => n.nodeName === '#text').map(n => (n as DefaultTreeAdapterMap['textNode']).value).join(''); }
function setText(node: Parent, value: string): void { node.childNodes = [{ nodeName: '#text', value, parentNode: node }]; }
function attr(node: Element, key: string): string | undefined { return node.attrs.find(a => a.name === key)?.value; }
function append(parent: Parent, html: string, first = false): void {
  const nodes = parseFragment(html).childNodes;
  for (const node of nodes) node.parentNode = parent;
  if (first) parent.childNodes.unshift(...nodes); else parent.childNodes.push(...nodes);
}

/** The HTML remains untrusted. The response header, not this rewrite, enforces isolation. */
export function prepareVisual(html: string, interactive: boolean, source = visualLibrarySource): string {
  const doc = parse(html);
  const root = doc.childNodes.find(n => isElement(n) && n.tagName === 'html') as Element;
  const head = root.childNodes.find(n => isElement(n) && n.tagName === 'head') as Element;
  const body = root.childNodes.find(n => isElement(n) && n.tagName === 'body') as Element;
  const modules = new Map<VisualLibrary, string>();
  const moduleUrl = (library: VisualLibrary) => {
    let url = modules.get(library);
    if (!url) { url = 'data:text/javascript;base64,' + Buffer.from(source(library)).toString('base64'); modules.set(library, url); }
    return url;
  };
  let needsThreeMap = false;
  let hasThreeMap = false;
  const walk = (node: Node): void => {
    if (isElement(node) && node.tagName === 'script' && interactive) {
      const src = attr(node, 'src');
      const library = src ? visualLibrary(src) : null;
      if (library) {
        if (library === 'orbit-controls') needsThreeMap = true;
        node.attrs = node.attrs.filter(a => !['src', 'integrity', 'crossorigin', 'async', 'defer'].includes(a.name));
        setText(node, escapeScript(source(library)));
      }
      if (attr(node, 'type') === 'importmap') {
        try {
          const map = JSON.parse(textOf(node));
          const imports = map.imports;
          if (imports && typeof imports === 'object' && !Array.isArray(imports)) {
            for (const [key, value] of Object.entries(imports)) {
              if (typeof value !== 'string') continue;
              const known = visualLibrary(value);
              if (known === 'three' || known === 'orbit-controls') {
                imports[key] = moduleUrl(known);
                if (known === 'orbit-controls') needsThreeMap = true;
              }
            }
            if (needsThreeMap && !imports.three) imports.three = moduleUrl('three');
            if (imports.three) hasThreeMap = true;
          }
          setText(node, JSON.stringify(map).replace(/</g, '\\u003c'));
        } catch { /* Invalid import maps are left to the browser; no network is allowed. */ }
      } else if (!src && attr(node, 'type') === 'module') {
        let code = textOf(node);
        code = code.replace(/https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)\/[A-Za-z0-9@._/+-]+/g, url => {
          const known = visualLibrary(url);
          if (known === 'three' || known === 'orbit-controls') { if (known === 'orbit-controls') needsThreeMap = true; return moduleUrl(known); }
          return url;
        });
        setText(node, escapeScript(code));
      }
    }
    if (isElement(node) && !interactive) {
      // A script-limited fallback must not retain automatic refreshes or clickable
      // outbound URLs when opened directly in an older browser.
      if (node.tagName === 'meta' && attr(node, 'http-equiv')?.toLowerCase() === 'refresh') node.attrs = [];
      if (node.tagName === 'a' || node.tagName === 'area') node.attrs = node.attrs.filter(a => !['href', 'ping', 'xlink:href'].includes(a.name));
    }
    if (isParent(node)) for (const child of node.childNodes) walk(child);
    // HTML template contents are not active; any later inserted scripts still meet the same CSP/firewall.
  };
  walk(doc);
  if (needsThreeMap && !hasThreeMap) append(head, `<script type="importmap">${JSON.stringify({ imports: { three: moduleUrl('three') } })}</script>`, true);
  // Guarantee the same limited bridge for old browsers; only its exact hash executes there.
  if (!serialize(head).includes(FRAME_SCRIPT)) append(head, `<script>${FRAME_SCRIPT}</script>`, true);
  if (!interactive) append(body, '<p role="note" data-aside-browser-note>Update to Chrome 152 or newer for this card’s interactive controls.</p>', true);
  const output = serialize(doc);
  if (Buffer.byteLength(output) > 8 * 1024 * 1024) throw new RangeError('visual_expanded_size');
  return output;
}
