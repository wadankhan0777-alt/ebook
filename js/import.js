/* ============================================================
 * import.js — bring your own books. Reads .epub (unzipped with
 * fflate, chapters extracted in spine order) and .txt files so
 * any book you own can be read and narrated like the rest of
 * the library — fully offline once imported.
 * ============================================================ */

const FolioImport = (() => {
  async function fromFile(file) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".epub")) return fromEpub(file);
    if (name.endsWith(".txt") || file.type === "text/plain") return fromTxt(file);
    throw new Error("Unsupported file — please pick a .epub or .txt file.");
  }

  async function fromTxt(file) {
    const text = FolioAPI.cleanText(await file.text());
    if (!text.trim()) throw new Error("That file appears to be empty.");
    return {
      title: file.name.replace(/\.txt$/i, "").replace(/[_-]+/g, " ").trim() || "Imported book",
      author: "My library",
      text,
    };
  }

  async function fromEpub(file) {
    if (typeof fflate === "undefined") throw new Error("EPUB support failed to load — refresh and try again.");
    const buf = new Uint8Array(await file.arrayBuffer());
    let files;
    try { files = fflate.unzipSync(buf); }
    catch { throw new Error("Couldn't open this EPUB — the file may be corrupted or DRM-protected."); }

    const dec = new TextDecoder();
    const read = (path) => {
      const f = files[path] || files[decodeURIComponent(path)];
      return f ? dec.decode(f) : null;
    };

    const container = read("META-INF/container.xml");
    if (!container) throw new Error("Not a valid EPUB (missing container.xml).");
    const containerDoc = new DOMParser().parseFromString(container, "application/xml");
    const rootfile = containerDoc.querySelector("rootfile");
    const opfPath = rootfile && rootfile.getAttribute("full-path");
    const opfXml = opfPath && read(opfPath);
    if (!opfXml) throw new Error("Not a valid EPUB (missing package file).");
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
    const opf = new DOMParser().parseFromString(opfXml, "application/xml");

    const title =
      textOf(opf, "dc:title") || textOf(opf, "title") || file.name.replace(/\.epub$/i, "");
    const author = textOf(opf, "dc:creator") || textOf(opf, "creator") || "My library";

    // manifest: id -> {href, type}
    const manifest = {};
    for (const item of opf.getElementsByTagName("item")) {
      manifest[item.getAttribute("id")] = {
        href: item.getAttribute("href"),
        type: item.getAttribute("media-type") || "",
      };
    }

    // spine order, skipping non-linear extras (covers, toc pages)
    const chapters = [];
    for (const ref of opf.getElementsByTagName("itemref")) {
      if (ref.getAttribute("linear") === "no") continue;
      const item = manifest[ref.getAttribute("idref")];
      if (!item || !/xhtml|html/i.test(item.type)) continue;
      const html = read(resolvePath(opfDir, item.href));
      if (html) chapters.push(html);
    }
    if (!chapters.length) throw new Error("No readable chapters found in this EPUB.");

    const parts = [];
    for (const html of chapters) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const body = doc.body;
      if (!body) continue;
      const t = extractText(body);
      if (t.trim()) parts.push(t);
    }
    const text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new Error("This EPUB contains no extractable text.");
    return { title: title.trim(), author: author.trim(), text };
  }

  function textOf(doc, tag) {
    const el = doc.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : "";
  }

  function resolvePath(dir, href) {
    let path = dir + href;
    while (path.includes("../")) path = path.replace(/[^/]+\/\.\.\//, "");
    return path.split("#")[0];
  }

  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "LI", "TR", "BR", "HR", "FIGURE", "ASIDE"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "NAV", "SVG", "IMG", "FIGCAPTION", "SUP"]);

  /** Flatten XHTML into plain text with blank-line paragraph breaks.
   *  Headings are uppercased so the reader styles them as chapters. */
  function extractText(root) {
    let out = "";
    const brk = () => { if (out && !/\n\n$/.test(out)) out = out.replace(/[ \t]+$/, "") + "\n\n"; };
    (function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue.replace(/\s+/g, " ");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.tagName)) return;
      if (/^H[1-4]$/.test(node.tagName)) {
        const t = node.textContent.replace(/\s+/g, " ").trim();
        if (t) { brk(); out += t.toUpperCase(); brk(); }
        return;
      }
      const isBlock = BLOCK.has(node.tagName);
      if (isBlock) brk();
      for (const child of node.childNodes) walk(child);
      if (isBlock) brk();
    })(root);
    return out.trim();
  }

  return { fromFile };
})();
