/*
 * pdf-parser.js
 * -------------
 * Parses a LinkedIn Recruiter "Save to PDF" profile export into a structured
 * object, entirely in the browser using PDF.js.
 *
 * LinkedIn Recruiter PDFs use a very consistent two-column template:
 *
 *   Left sidebar (x < ~33% of page width):
 *     - Contact            (LinkedIn URL, sometimes email/phone)
 *     - Top Skills         (usually the candidate's top 3 skills)
 *     - Languages
 *     - Certifications
 *     - Honors-Awards / Publications / Patents (when present)
 *
 *   Main column (x >= ~33% of page width):
 *     - Name               (largest font on the page)
 *     - Headline           (current role / tagline)
 *     - Location
 *     - Summary
 *     - Experience         (Company / Title / Dates / Location / bullets)
 *     - Education          (School / Degree / Dates)
 *     - Activity           ("MM/DD/YYYY, Viewed by <name>")
 *
 * The parser separates the two columns by x-coordinate, groups text into
 * lines, identifies section headers from a known vocabulary, and uses the
 * relative font-size hierarchy (Name 26 > headers ~16 > company 12 >
 * title 11.5 > body 10.5) to classify lines within a section.
 *
 * Exposes: window.LinkedInParser.parseArrayBuffer(buf, fileName) -> Promise<candidate>
 */
(function () {
  'use strict';

  // ---- Configuration -------------------------------------------------------

  // Fraction of page width used to split the left sidebar from the main column.
  // Sidebar text sits around x=22, main column around x=224 on a 612pt page,
  // so anything past ~33% of the width is "main".
  var COLUMN_SPLIT_RATIO = 0.34;

  // Section headers that live in the left sidebar.
  var SIDEBAR_HEADERS = {
    'contact': 'contact',
    'top skills': 'topSkills',
    'skills': 'topSkills',
    'languages': 'languages',
    'certifications': 'certifications',
    'honors-awards': 'honorsAwards',
    'honors & awards': 'honorsAwards',
    'publications': 'publications',
    'patents': 'patents'
  };

  // Section headers that live in the main column.
  var MAIN_HEADERS = {
    'summary': 'summary',
    'experience': 'experience',
    'education': 'education',
    'licenses & certifications': 'licenses',
    'volunteering': 'volunteering',
    'volunteer experience': 'volunteering',
    'projects': 'projects',
    'recommendations': 'recommendations',
    'activity': 'activity'
  };

  var MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
  // A standalone date-range line, e.g. "March 2023 - December 2025 (2 years 10 months)"
  // or "January 2020 - Present (1 year)" or "2014 - 2017".
  var DATE_RANGE = new RegExp(
    '(?:' + MONTHS + ')\\s+\\d{4}\\s*[\\u2012-\\u2015\\-]\\s*(?:Present|(?:' + MONTHS + ')\\s+\\d{4}|\\d{4})' +
    '|^\\d{4}\\s*[\\u2012-\\u2015\\-]\\s*(?:Present|\\d{4})', 'i');
  // Duration inside a date line, e.g. "(2 years 10 months)".
  var DURATION = /\(\s*(?:(\d+)\s*years?)?[\s,]*(?:(\d+)\s*months?)?\s*\)/i;
  var BULLET = /^[•·‣◦⁃∙>\-\*]\s*/;

  // ---- Low-level PDF.js text extraction ------------------------------------

  // Pull every text item from every page, tagged with page index, x, y and
  // font size. PDF.js origin is bottom-left, so a larger y means higher up.
  function extractItems(pdf) {
    var pages = [];
    var chain = Promise.resolve();
    for (var p = 1; p <= pdf.numPages; p++) {
      (function (pageNum) {
        chain = chain.then(function () {
          return pdf.getPage(pageNum).then(function (page) {
            var viewport = page.getViewport({ scale: 1 });
            return page.getTextContent().then(function (content) {
              var items = [];
              content.items.forEach(function (it) {
                if (typeof it.str !== 'string') return;
                var tr = it.transform;
                // Font size is rotation-robust as the length of the y-axis vector.
                var size = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || it.height || 0;
                items.push({
                  str: it.str,
                  x: tr[4],
                  y: tr[5],
                  w: it.width || 0,
                  size: size,
                  page: pageNum,
                  eol: !!it.hasEOL
                });
              });
              pages[pageNum - 1] = { width: viewport.width, height: viewport.height, items: items };
            });
          });
        });
      })(p);
    }
    return chain.then(function () { return pages; });
  }

  // Group a list of items (already restricted to one column) into text lines.
  // Items are clustered by page + similar y; within a line they are ordered by
  // x and joined, inserting a space where there is a horizontal gap.
  function groupLines(items) {
    if (!items.length) return [];
    var sorted = items.slice().sort(function (a, b) {
      if (a.page !== b.page) return a.page - b.page;
      if (Math.abs(a.y - b.y) > 2.5) return b.y - a.y; // higher y first (top of page)
      return a.x - b.x;
    });

    var lines = [];
    var cur = null;
    sorted.forEach(function (it) {
      var sameLine = cur &&
        cur.page === it.page &&
        Math.abs(cur.y - it.y) <= Math.max(2.5, it.size * 0.4);
      if (!sameLine) {
        cur = { page: it.page, y: it.y, size: it.size, parts: [], minX: it.x };
        lines.push(cur);
      }
      cur.parts.push(it);
      cur.size = Math.max(cur.size, it.size);
      cur.minX = Math.min(cur.minX, it.x);
    });

    return lines.map(function (ln) {
      ln.parts.sort(function (a, b) { return a.x - b.x; });
      var text = '';
      var prev = null;
      ln.parts.forEach(function (it) {
        if (prev) {
          var gap = it.x - (prev.x + prev.w);
          var prevEndsSpace = /\s$/.test(text);
          var curStartsSpace = /^\s/.test(it.str);
          if (!prevEndsSpace && !curStartsSpace && gap > it.size * 0.18) text += ' ';
        }
        text += it.str;
        prev = it;
      });
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        rawText: text,
        y: ln.y,
        size: ln.size,
        page: ln.page,
        x: ln.minX
      };
    }).filter(function (ln) { return ln.text.length > 0; });
  }

  function isPageFooter(text) {
    return /^Page\s+\d+\s+of\s+\d+$/i.test(text);
  }

  // ---- Sidebar parsing -----------------------------------------------------

  function parseSidebar(lines) {
    var out = {
      contact: [], topSkills: [], languages: [], certifications: [],
      honorsAwards: [], publications: [], patents: []
    };
    var section = null;
    var prevY = null;
    var prevPage = null;

    lines.forEach(function (ln) {
      if (isPageFooter(ln.text)) return;
      var key = ln.text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (SIDEBAR_HEADERS.hasOwnProperty(key)) {
        section = SIDEBAR_HEADERS[key];
        prevY = null;
        prevPage = ln.page;
        return;
      }
      if (!section) return;

      var list = out[section];
      // Continuation of a wrapped item: small vertical gap on the same page.
      var gap = (prevY !== null && prevPage === ln.page) ? (prevY - ln.y) : Infinity;
      var isWrap = gap < ln.size * 1.45 && list.length > 0;
      if (isWrap) {
        list[list.length - 1] += ' ' + ln.text;
      } else {
        list.push(ln.text);
      }
      prevY = ln.y;
      prevPage = ln.page;
    });

    // Normalise contact: collapse to a single string and pull out URL / email.
    var contactText = out.contact.join(' ');
    out.contactRaw = contactText;
    var compact = contactText.replace(/\s+/g, '');
    var urlMatch = compact.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i);
    out.linkedinUrl = urlMatch ? normaliseUrl(urlMatch[0]) : '';
    var emailMatch = contactText.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
    out.email = emailMatch ? emailMatch[0] : '';
    var phoneMatch = contactText.match(/(\+?\d[\d\s().\-]{7,}\d)/);
    out.phone = phoneMatch ? phoneMatch[1].trim() : '';

    return out;
  }

  function normaliseUrl(u) {
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^www\./i, 'www.');
    return u;
  }

  // ---- Main-column parsing -------------------------------------------------

  function splitMainSections(lines) {
    var header = { name: '', text: [] }; // everything before the first known header
    var sections = {};                   // key -> array of lines
    var current = null;
    var seenHeader = false;

    lines.forEach(function (ln) {
      if (isPageFooter(ln.text)) return;
      var key = ln.text.toLowerCase().replace(/\s+/g, ' ').trim();
      var isHeader = MAIN_HEADERS.hasOwnProperty(key) && ln.size >= 13.5;
      if (isHeader) {
        seenHeader = true;
        current = MAIN_HEADERS[key];
        if (!sections[current]) sections[current] = [];
        return;
      }
      if (!seenHeader) {
        header.text.push(ln);
      } else if (current) {
        sections[current].push(ln);
      }
    });

    return { header: header, sections: sections };
  }

  // Name / headline / location all live above the first section header.
  function parseHeader(headerLines) {
    var result = { name: '', headline: '', location: '' };
    var lines = headerLines.filter(function (l) { return l.text.length; });
    if (!lines.length) return result;

    var maxSize = lines.reduce(function (m, l) { return Math.max(m, l.size); }, 0);

    // Name = the leading run of largest-font lines (handles wrapped names).
    var i = 0;
    var nameParts = [];
    while (i < lines.length && lines[i].size >= maxSize - 0.6) {
      nameParts.push(lines[i].text);
      i++;
    }
    result.name = nameParts.join(' ').trim();

    var rest = lines.slice(i);
    if (rest.length) {
      var last = rest[rest.length - 1].text;
      var looksLikeLocation = last.indexOf('|') === -1 && last.length < 80 &&
        !/[.!?]$/.test(last);
      if (looksLikeLocation && rest.length >= 1) {
        result.location = last;
        result.headline = rest.slice(0, rest.length - 1).map(function (l) { return l.text; }).join(' ').trim();
      } else {
        result.headline = rest.map(function (l) { return l.text; }).join(' ').trim();
      }
    }
    return result;
  }

  function modeSize(sizes) {
    var counts = {};
    var best = sizes[0], bestN = 0;
    sizes.forEach(function (s) {
      var k = s.toFixed(1);
      counts[k] = (counts[k] || 0) + 1;
      if (counts[k] > bestN) { bestN = counts[k]; best = s; }
    });
    return best;
  }

  function parseExperience(lines) {
    var entries = [];
    if (!lines.length) return entries;
    var sizes = lines.map(function (l) { return l.size; });
    var maxSize = Math.max.apply(null, sizes);
    var bodySize = modeSize(sizes);
    var cur = null;

    lines.forEach(function (ln) {
      var t = ln.text;
      var isDate = DATE_RANGE.test(t);
      var isCompanyTier = !isDate && ln.size >= maxSize - 0.4 && ln.size > bodySize + 0.4;

      if (isCompanyTier) {
        cur = { company: t, title: '', period: '', location: '', description: [], durationMonths: 0 };
        entries.push(cur);
        return;
      }
      if (!cur) {
        cur = { company: '', title: '', period: '', location: '', description: [], durationMonths: 0 };
        entries.push(cur);
      }

      if (isDate) {
        if (!cur.period) {
          cur.period = t;
          cur.durationMonths = parseDuration(t);
        } else {
          cur.description.push(t);
        }
        return;
      }

      var isBullet = BULLET.test(t);
      var isTitleTier = ln.size > bodySize + 0.4 && ln.size < maxSize - 0.4;

      if (isBullet) {
        cur.description.push(t.replace(BULLET, '').trim());
        return;
      }
      // Non-bullet text:
      if (!cur.period && (isTitleTier || !cur.title)) {
        cur.title = cur.title ? cur.title + ' ' + t : t;
      } else if (cur.period && !cur.location && cur.description.length === 0 && t.length < 60) {
        cur.location = t;
      } else if (cur.description.length) {
        // Wrapped continuation of the previous bullet.
        cur.description[cur.description.length - 1] += ' ' + t;
      } else {
        cur.description.push(t);
      }
    });

    return entries;
  }

  function parseDuration(text) {
    var m = text.match(DURATION);
    if (!m) return 0;
    var years = m[1] ? parseInt(m[1], 10) : 0;
    var months = m[2] ? parseInt(m[2], 10) : 0;
    return years * 12 + months;
  }

  function parseEducation(lines) {
    var entries = [];
    if (!lines.length) return entries;
    var maxSize = Math.max.apply(null, lines.map(function (l) { return l.size; }));
    var cur = null;

    lines.forEach(function (ln) {
      var isSchool = ln.size >= maxSize - 0.4;
      if (isSchool) {
        cur = { school: ln.text, degree: '', period: '', blob: '' };
        entries.push(cur);
        return;
      }
      if (!cur) {
        cur = { school: '', degree: '', period: '', blob: '' };
        entries.push(cur);
      }
      cur.blob = cur.blob ? cur.blob + ' ' + ln.text : ln.text;
    });

    entries.forEach(function (e) {
      var blob = (e.blob || '').replace(/\s+/g, ' ').trim();
      var dm = blob.match(/\(([^)]*\d{4}[^)]*)\)/);
      if (dm) e.period = dm[1].trim();
      var degree = blob
        .replace(/[·•]\s*\([^)]*\d{4}[^)]*\)/, '')
        .replace(/\([^)]*\d{4}[^)]*\)/, '')
        .replace(/[·•]\s*$/, '')
        .trim();
      e.degree = degree;
      delete e.blob;
    });
    return entries;
  }

  function parseActivity(lines) {
    var text = lines.map(function (l) { return l.text; }).join(' ');
    var out = { viewedDate: '', viewedBy: '' };
    var m = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*,?\s*Viewed by\s+(.+)/i);
    if (m) {
      out.viewedDate = m[1];
      out.viewedBy = m[2].trim();
    } else {
      var d = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (d) out.viewedDate = d[1];
    }
    return out;
  }

  // ---- Top-level assembly --------------------------------------------------

  function buildCandidate(pages, fileName) {
    var allItems = [];
    var splitX = 0;
    pages.forEach(function (pg) {
      splitX = Math.max(splitX, pg.width * COLUMN_SPLIT_RATIO);
    });
    pages.forEach(function (pg) {
      pg.items.forEach(function (it) { allItems.push(it); });
    });

    var sidebarItems = allItems.filter(function (it) { return it.x < splitX; });
    var mainItems = allItems.filter(function (it) { return it.x >= splitX; });

    // If the document is single-column (no real sidebar), treat all as main.
    if (sidebarItems.length < 3) {
      mainItems = allItems.slice();
      sidebarItems = [];
    }

    var sidebarLines = groupLines(sidebarItems);
    var mainLines = groupLines(mainItems);

    var sidebar = parseSidebar(sidebarLines);
    var main = splitMainSections(mainLines);
    var header = parseHeader(main.header.text);
    var sections = main.sections;

    var experience = parseExperience(sections.experience || []);
    var education = parseEducation(sections.education || []);
    var summary = (sections.summary || []).map(function (l) { return l.text; }).join(' ').trim();
    var activity = parseActivity(sections.activity || []);

    var totalMonths = experience.reduce(function (s, e) { return s + (e.durationMonths || 0); }, 0);
    var current = experience[0] || {};

    var candidate = {
      sourceFile: fileName || '',
      name: header.name,
      headline: header.headline,
      location: header.location,
      linkedinUrl: sidebar.linkedinUrl,
      email: sidebar.email,
      phone: sidebar.phone,
      currentTitle: current.title || '',
      currentCompany: current.company || '',
      topSkills: dedupe(sidebar.topSkills),
      languages: dedupe(sidebar.languages),
      certifications: dedupe(sidebar.certifications),
      honorsAwards: dedupe(sidebar.honorsAwards),
      summary: summary,
      experience: experience,
      education: education,
      totalExperienceMonths: totalMonths,
      totalExperienceText: formatDuration(totalMonths),
      viewedDate: activity.viewedDate,
      viewedBy: activity.viewedBy
    };

    candidate.warnings = collectWarnings(candidate);
    return candidate;
  }

  function dedupe(arr) {
    var seen = {};
    var out = [];
    (arr || []).forEach(function (v) {
      var t = (v || '').trim();
      var k = t.toLowerCase();
      if (t && !seen[k]) { seen[k] = 1; out.push(t); }
    });
    return out;
  }

  function formatDuration(months) {
    if (!months) return '';
    var y = Math.floor(months / 12);
    var m = months % 12;
    var parts = [];
    if (y) parts.push(y + (y === 1 ? ' yr' : ' yrs'));
    if (m) parts.push(m + (m === 1 ? ' mo' : ' mos'));
    return parts.join(' ');
  }

  function collectWarnings(c) {
    var w = [];
    if (!c.name) w.push('Could not detect a name — file may not be a LinkedIn Recruiter export.');
    if (!c.topSkills.length && !c.experience.length) {
      w.push('No skills or experience detected — layout may differ from the expected template.');
    }
    return w;
  }

  // ---- Public API ----------------------------------------------------------

  function parseArrayBuffer(buf, fileName) {
    if (!window.pdfjsLib) {
      return Promise.reject(new Error('PDF.js library failed to load.'));
    }
    var task = window.pdfjsLib.getDocument({ data: buf });
    return task.promise.then(function (pdf) {
      return extractItems(pdf).then(function (pages) {
        var candidate = buildCandidate(pages, fileName);
        return candidate;
      });
    });
  }

  window.LinkedInParser = {
    parseArrayBuffer: parseArrayBuffer,
    // Exposed for testing / debugging:
    _internals: {
      groupLines: groupLines,
      parseExperience: parseExperience,
      parseEducation: parseEducation,
      parseSidebar: parseSidebar,
      DATE_RANGE: DATE_RANGE
    }
  };
})();
