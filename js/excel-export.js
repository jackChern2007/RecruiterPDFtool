/*
 * excel-export.js
 * ---------------
 * Turns the structured candidate objects produced by pdf-parser.js into a
 * multi-sheet .xlsx workbook using SheetJS (XLSX), all in the browser.
 *
 * Sheets:
 *   - "Candidates"  : one row per candidate (the summary view).
 *   - "Experience"  : one row per job, for deeper analysis.
 *   - "Skills"      : one row per candidate/skill pair, so recruiters can
 *                     filter or pivot by skill.
 *
 * Exposes: window.ExcelExport.download(candidates, fileName)
 */
(function () {
  'use strict';

  function joinList(arr) {
    return (arr || []).join(', ');
  }

  function experienceSummary(exp) {
    return (exp || []).map(function (e) {
      var bits = [];
      if (e.title) bits.push(e.title);
      if (e.company) bits.push('@ ' + e.company);
      var s = bits.join(' ');
      if (e.period) s += ' (' + e.period.replace(/\s*\(.*$/, '').trim() + ')';
      return s.trim();
    }).filter(Boolean).join('  |  ');
  }

  function educationSummary(edu) {
    return (edu || []).map(function (e) {
      var bits = [];
      if (e.degree) bits.push(e.degree);
      if (e.school) bits.push(e.school);
      var s = bits.join(', ');
      if (e.period) s += ' (' + e.period + ')';
      return s.trim();
    }).filter(Boolean).join('  |  ');
  }

  function buildCandidatesSheet(candidates) {
    var rows = candidates.map(function (c) {
      return {
        'Name': c.name || '',
        'Headline': c.headline || '',
        'Location': c.location || '',
        'Current Title': c.currentTitle || '',
        'Current Company': c.currentCompany || '',
        'Top Skills': joinList(c.topSkills),
        'Languages': joinList(c.languages),
        'Certifications': joinList(c.certifications),
        'Experience (approx.)': c.totalExperienceText || '',
        'Education': educationSummary(c.education),
        'Experience': experienceSummary(c.experience),
        'Summary': c.summary || '',
        'LinkedIn URL': c.linkedinUrl || '',
        'Email': c.email || '',
        'Phone': c.phone || '',
        'Date Viewed': c.viewedDate || '',
        'Source File': c.sourceFile || '',
        'Parse Notes': (c.warnings || []).join(' ')
      };
    });
    var ws = XLSX.utils.json_to_sheet(rows, {
      header: [
        'Name', 'Headline', 'Location', 'Current Title', 'Current Company',
        'Top Skills', 'Languages', 'Certifications', 'Experience (approx.)',
        'Education', 'Experience', 'Summary', 'LinkedIn URL', 'Email', 'Phone',
        'Date Viewed', 'Source File', 'Parse Notes'
      ]
    });
    ws['!cols'] = [
      { wch: 22 }, { wch: 40 }, { wch: 24 }, { wch: 26 }, { wch: 22 },
      { wch: 34 }, { wch: 20 }, { wch: 34 }, { wch: 16 }, { wch: 50 },
      { wch: 60 }, { wch: 70 }, { wch: 38 }, { wch: 26 }, { wch: 18 },
      { wch: 14 }, { wch: 26 }, { wch: 40 }
    ];
    ws['!autofilter'] = { ref: ws['!ref'] };
    return ws;
  }

  function buildExperienceSheet(candidates) {
    var rows = [];
    candidates.forEach(function (c) {
      (c.experience || []).forEach(function (e) {
        rows.push({
          'Candidate': c.name || '',
          'Company': e.company || '',
          'Title': e.title || '',
          'Period': e.period || '',
          'Duration': formatMonths(e.durationMonths),
          'Location': e.location || '',
          'Description': (e.description || []).map(function (d) { return '• ' + d; }).join('\n'),
          'Source File': c.sourceFile || ''
        });
      });
    });
    if (!rows.length) rows.push({ 'Candidate': '', 'Company': '', 'Title': '', 'Period': '', 'Duration': '', 'Location': '', 'Description': '', 'Source File': '' });
    var ws = XLSX.utils.json_to_sheet(rows, {
      header: ['Candidate', 'Company', 'Title', 'Period', 'Duration', 'Location', 'Description', 'Source File']
    });
    ws['!cols'] = [
      { wch: 22 }, { wch: 26 }, { wch: 30 }, { wch: 34 }, { wch: 14 },
      { wch: 22 }, { wch: 80 }, { wch: 26 }
    ];
    ws['!autofilter'] = { ref: ws['!ref'] };
    return ws;
  }

  function buildSkillsSheet(candidates) {
    var rows = [];
    candidates.forEach(function (c) {
      var skills = (c.topSkills || []).slice();
      // Also surface certifications as a separate "type" so they can be filtered.
      skills.forEach(function (s) {
        rows.push({ 'Candidate': c.name || '', 'Type': 'Top Skill', 'Value': s, 'Source File': c.sourceFile || '' });
      });
      (c.languages || []).forEach(function (s) {
        rows.push({ 'Candidate': c.name || '', 'Type': 'Language', 'Value': s, 'Source File': c.sourceFile || '' });
      });
      (c.certifications || []).forEach(function (s) {
        rows.push({ 'Candidate': c.name || '', 'Type': 'Certification', 'Value': s, 'Source File': c.sourceFile || '' });
      });
    });
    if (!rows.length) rows.push({ 'Candidate': '', 'Type': '', 'Value': '', 'Source File': '' });
    var ws = XLSX.utils.json_to_sheet(rows, { header: ['Candidate', 'Type', 'Value', 'Source File'] });
    ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 40 }, { wch: 26 }];
    ws['!autofilter'] = { ref: ws['!ref'] };
    return ws;
  }

  function formatMonths(months) {
    if (!months) return '';
    var y = Math.floor(months / 12);
    var m = months % 12;
    var parts = [];
    if (y) parts.push(y + (y === 1 ? ' yr' : ' yrs'));
    if (m) parts.push(m + (m === 1 ? ' mo' : ' mos'));
    return parts.join(' ');
  }

  function timestamp() {
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function download(candidates, fileName) {
    if (!window.XLSX) throw new Error('XLSX library failed to load.');
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildCandidatesSheet(candidates), 'Candidates');
    XLSX.utils.book_append_sheet(wb, buildExperienceSheet(candidates), 'Experience');
    XLSX.utils.book_append_sheet(wb, buildSkillsSheet(candidates), 'Skills');
    var name = fileName || ('linkedin-candidates-' + timestamp() + '.xlsx');
    XLSX.writeFile(wb, name);
  }

  window.ExcelExport = { download: download };
})();
