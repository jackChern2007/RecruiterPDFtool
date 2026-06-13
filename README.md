# Recruiter PDF → Excel

A small, **fully client-side** web app that parses **LinkedIn Recruiter profile
PDFs** ("Save to PDF" exports) and turns them into a clean, filterable Excel
workbook — skills, experience, education, certifications, languages and contact
details.

> 🔒 **Private by design.** PDFs are parsed in your browser with
> [PDF.js](https://mozilla.github.io/pdf.js/). Nothing is ever uploaded to a
> server, which is exactly why it can run on GitHub Pages.

---

## What it extracts

For each candidate PDF the parser pulls out:

| Field | Notes |
|---|---|
| Name, Headline, Location | From the top of the profile |
| LinkedIn URL, Email, Phone | From the **Contact** panel (when present) |
| Top Skills | LinkedIn's "Top Skills" panel (usually the top 3) |
| Languages | e.g. *German (Elementary)* |
| Certifications | Full list from the sidebar |
| Summary | The profile's "About" text |
| Experience | One entry per role: company, title, dates, duration, location, bullet points |
| Education | School, degree/field, dates |
| Current Title / Company | Derived from the most recent role |
| Total experience (approx.) | Summed from each role's duration |
| Date viewed | From the export's "Activity" footer |

You can drop **multiple PDFs at once** — each becomes a row.

## The Excel output

The downloaded `.xlsx` has three tabs (all with auto-filters enabled):

1. **Candidates** — one row per person (the summary view).
2. **Experience** — one row per job, for deeper analysis.
3. **Skills** — one row per candidate/skill (and language/certification), so you
   can pivot or filter to "everyone who lists *Salesforce*".

---

## Using it

1. Open the published site (see **Deployment** below), or open `index.html`
   locally.
2. In LinkedIn **Recruiter** (or on a profile), choose **More → Save to PDF** to
   export a candidate.
3. Drag the PDF(s) onto the drop zone.
4. Review the parsed candidates (click **Details** to inspect any one), then
   click **Download Excel**.

---

## Deployment (GitHub Pages)

This is a static site (plain HTML/CSS/JS), so it deploys to GitHub Pages with no
build step. Two options:

### Option A — GitHub Actions (recommended)

A workflow is included at `.github/workflows/deploy.yml`. Once the code is on
your default branch (`main`):

1. Go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

Every push to `main` then publishes the site automatically. The workflow prints
the live URL (typically `https://<user>.github.io/<repo>/`).

### Option B — Deploy from a branch

1. Go to **Settings → Pages**.
2. Under **Source**, choose **Deploy from a branch**.
3. Pick your branch and the **`/ (root)`** folder, then **Save**.

> The repo includes a `.nojekyll` file so GitHub Pages serves the files as-is.

---

## Local development

No tooling required — just serve the folder so the browser allows module/CDN
loads:

```bash
# Python
python3 -m http.server 8000
# then open http://localhost:8000

# …or just open index.html directly in a browser.
```

### Optional: run the parser test in Node

There's a tiny harness used during development that runs the real parser against
a PDF and prints the structured result:

```bash
npm install pdfjs-dist@3.11.174 xlsx@0.18.5
node test/parse-sample.js path/to/profile.pdf
```

---

## How the parsing works

LinkedIn Recruiter PDFs use a consistent two-column template. The parser:

1. Uses **PDF.js** to read every text run with its `(x, y)` position and font
   size.
2. Splits the page into the **left sidebar** (Contact / Skills / Languages /
   Certifications) and the **main column** (Name / Summary / Experience /
   Education) by x-coordinate.
3. Detects section headers from a known vocabulary and uses the **font-size
   hierarchy** (name ≈ 26pt > section headers ≈ 16pt > company ≈ 12pt > title ≈
   11.5pt > body ≈ 10.5pt) to classify each line.
4. Re-joins wrapped lines (e.g. a skill that spilled onto a second line) using
   line spacing, and parses date ranges/durations with regular expressions.

See `js/pdf-parser.js` for the details.

## Limitations

- Built for the **English** LinkedIn Recruiter "Save to PDF" layout. Other
  languages or a future template change may need tweaks to the section
  vocabulary in `js/pdf-parser.js`.
- LinkedIn's PDF only includes **Top Skills** (usually 3), not the candidate's
  full skill list — that's a limit of the source document, not the parser.
- Image-only/scanned PDFs have no extractable text and won't parse (these
  exports are text-based, so that's rarely an issue).
- A profile that diverges from the template is still parsed best-effort and
  flagged with a note in the **Parse Notes** column.

## Tech

- [PDF.js](https://github.com/mozilla/pdf.js) — in-browser PDF text extraction
- [SheetJS / xlsx](https://github.com/SheetJS/sheetjs) — in-browser `.xlsx`
  generation
- Vanilla HTML/CSS/JS — no framework, no build step

Both libraries load from cdnjs with pinned versions and Subresource Integrity
hashes.

## License

MIT — see [`LICENSE`](LICENSE).
