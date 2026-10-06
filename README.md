# Tender Package Builder · টেন্ডার প্যাকেজ বিল্ডার

AI DevFest 2026 – Vibe Coding Contest (Solo) · Problem: **Tender Document Package Builder**

| | |
|---|---|
| **Name** | Nafiz Mahmud Rimon |
| **Registration number** | 0802420205101094 |
| **Live website (HTTPS)** | **https://vagabond2003.github.io/devfest-0802420205101094/** |
| **Repository** | https://github.com/Vagabond2003/devfest-0802420205101094 |
| **Output for the sample pack** | [`output/T-2026-0417_Package.pdf`](output/T-2026-0417_Package.pdf) |
| **Screenshots** | [`screenshots/`](screenshots/) |

A **frontend-only** web app that helps office staff turn a set of PDF files into **one complete, checked and correctly
ordered PDF package**, ready to submit. Everything runs in the browser – no file is ever uploaded anywhere.

---

## How to run

Use the live link above in the latest Google Chrome. Nothing to install, no sign-in.

To run locally (Node.js 20.19+ or 22+):

```bash
npm install
npm run dev        # development server → http://localhost:5173
npm run build      # production build → dist/
npm run preview    # serve the production build
```

Deployment: every push to `main` is built and published to GitHub Pages by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), so the live site always matches the latest commit.

### Using the app (4 steps, Bangla or English)

1. **Open `requirements.json`** – tender details and the required documents appear, sorted by `order`.
2. **Add the PDF files** – select or drag all files at once. Non-PDF, damaged and password-protected files are rejected
   with a clear message. Each file shows its name and page count; duplicates are marked.
3. **Match files to documents** – pick a file for each document (or press *Auto-match by file name*), type the expiry
   date where needed, use *View* to look inside a file. The status of every document updates immediately.
4. **Generate package** – the button stays disabled and lists the reasons while anything blocks the package.
   When everything is fine, generate and download `<tender_id>_Package.pdf`.

---

## Main features (all main tasks done)

| Task | How it is done |
|---|---|
| 4.1 Load the list | `requirements.json` is validated (clear error messages for wrong files) and the documents are shown sorted by `order`. |
| 4.2 Upload files | Many files at once (button or drag & drop), file name + page count (pdf.js), remove any file. Files are checked by their **content signature (`%PDF-`)**, not just the extension – `company_logo.png` is rejected with a clear message. Limits: 30 files / 50 MB. |
| 4.3 Match files | One drop-down per document. A file already used for another document is disabled in the other lists (“used for …”). Change or clear a match at any time. |
| 4.4 Expiry dates | A date field appears when `has_expiry = true` and a file is matched. Changing the file clears the old date. |
| 4.5 Status | Exactly one status per document, recalculated on every change: **Missing, Expiry date needed, Expired, Not provided, OK** (Section 5 rules; expiring *on* the deadline is OK). |
| 4.6 Duplicates | SHA-256 of the file bytes. Files with identical content (even with different names) are marked in the file list, and once one copy is used, the other copies are disabled for every other document. |
| 4.7 Make the package | Generate is disabled while any document is Missing / Expiry date needed / Expired, and the reasons are listed in plain words. |
| 4.8 Download | Downloaded as `<tender_id>_Package.pdf` (also previewed inside the page). |
| 4.9 Two languages | One click switches the **whole app** between English and বাংলা (labels, buttons, messages, help text, statuses, numbers in Bangla digits). Document names come from `title_en` / `title_bn`. The choice is remembered. |

### Package rules (Section 6)

* **Page 1 – English cover**: tender ID, title, procuring entity, bidder, submission deadline, date the package was
  made, total pages and the list of included documents in order (optional documents that were not provided are noted).
* **Documents follow the cover sorted by `order`** – all pages of each file, in their original order (copied with
  pdf-lib, so text stays sharp and selectable). Optional documents with no file are skipped.
* **Footer on every page, including the cover**: `<tender_id> | Page X of Y`, where Y is the total page count.
* **The footer never covers content**: instead of printing on top of the page, every page is extended by a 30 pt white
  strip at its bottom and the footer is printed there. This matters for full-page scans such as `scan_0042.pdf`, which
  have no empty margin. Rotated pages are handled (the strip is added on the side that is *visually* the bottom).

## Bonus features

* **Index page** after the cover with the page where each document starts (optional checkbox, on by default).
* **Bangla text shown correctly in the PDF** – the index page shows each document's Bangla name. Standard PDF fonts
  cannot shape Bangla, so Bangla strings are drawn by the browser (correct conjuncts with the bundled Noto Sans Bengali
  font) and embedded as high-resolution images.
* **Seal or signature** – upload a PNG and place it on all pages, all document pages, the last page of each document, or
  chosen pages (e.g. `1, 3-5`), at a chosen position and size. It is kept above the footer strip.
* **Export the checklist as CSV** (order, ID, document, mandatory, file name, pages, expiry date, status) – UTF-8 with BOM
  so Bangla opens correctly in Excel.
* **Save and reopen** – work is auto-saved in the browser (IndexedDB) and restored on the next visit; you can also
  *Save project file* (a JSON file with the PDFs inside) and *Open project file* on another computer.
* **Auto-match by file name** – word matching with weights (rare words like “trade” count more than common words like
  “certificate”), common abbreviations (`cert`, `exp`, `tech`, `maf`…), Bangla titles, plus the document title found in
  the PDF text. It respects the one-file-per-document and duplicate rules, prefers the newer file (`_2026` over `_2025`)
  and a file whose expiry date is still valid. Suggestions are marked “Suggested” for the user to check.
* **Expiry date hints** – the app reads the PDF text and shows “Expiry date in document: …” (e.g. *VALID UNTIL 30 June
  2027*) with a one-click *Use this date*. The user stays in control; nothing is filled in silently.
* **Bad files handled safely** – damaged PDFs, PDFs with no pages and password-protected PDFs get a clear message instead
  of a crash. PDFs that open without a password but are protected against editing are accepted and added as page images.

## Problems found in the sample pack

| File | Problem | What the app does |
|---|---|---|
| `company_logo.png` | Not a PDF | Rejected with a clear message |
| `experience_cert.pdf` / `experience_cert (1).pdf` | Same content, different names | Both marked *Duplicate*; only one can be used |
| `trade_license_2025.pdf` | Expired on 2025-06-30, before the 2026-10-20 deadline | Status **Expired**, blocks the package; auto-match prefers `trade_license_2026.pdf` (valid to 2027-06-30) |
| `scan_0042.pdf` | Name says nothing – it is the **Signed Declaration** (a scanned image, no text) | Stays **Missing** until the user views it and matches it |
| `01_financial_proposal.pdf`, `02_technical_proposal.pdf` | Name numbers do not follow the tender order (Technical = 8, Financial = 9) | Package follows `order`, not file names |
| Audited Financial Statement, Manufacturer's Authorization | Optional, no file in the pack | **Not provided**, skipped, noted on the cover |
| Full-page scan | No free margin for a footer | Footer printed in an added strip, never on the content |

Final package for the sample pack: 17 pages = cover + index + 15 document pages.

## Known problems / limits

* Pages added as images (only for edit-protected PDFs) are not text-searchable.
* Fillable PDF form fields are kept as they look, but they are no longer editable form fields in the package.
* Pages become 30 pt taller because of the footer strip (needed so the footer never covers content).
* The date picker shows dates in the format of the computer's language settings.
* Expiry hints and auto-match are suggestions; scanned documents without text give no hints.

## Tech

React + TypeScript + Vite · [pdf-lib](https://pdf-lib.js.org/) (merge, cover, footer, seal) ·
[pdf.js](https://mozilla.github.io/pdf.js/) (page count, text, previews) · idb-keyval (IndexedDB) ·
Noto Sans Bengali via @fontsource (OFL). No backend, no database, no online storage, no API keys.

## AI tools used

* **Claude Code (Claude Opus 5.5)** – analysed the rulebook, problem statement and sample pack, wrote the code, ran
  end-to-end tests with the sample pack in headless Chrome, produced the screenshots and the output PDF, committed and
  pushed.

## Most useful prompt

> "Analyse the rules present in the Rule Book and Problem Statement and the statements, all the resources you will need
> are present in the repo and also all the rules are mentioned in the rule book and all the sample data too, my github
> currently contains an empty repo called devfest-0802420205101094, you may proceed"

## License

[MIT](LICENSE)
