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

  function buildCandidatesSheet(candidates, keywordsActive) {
    var rows = candidates.map(function (c) {
      var row = { 'Name': c.name || '' };
      if (keywordsActive) {
        row['Keyword Matches'] = c._keywordMatchCount || 0;
        row['Matched Keywords'] = joinList(c._matchedKeywords);
      }
      row['Headline'] = c.headline || '';
      row['Location'] = c.location || '';
      row['Current Title'] = c.currentTitle || '';
      row['Current Company'] = c.currentCompany || '';
      row['Top Skills'] = joinList(c.topSkills);
      row['Languages'] = joinList(c.languages);
      row['Certifications'] = joinList(c.certifications);
      row['Experience (approx.)'] = c.totalExperienceText || '';
      row['Education'] = educationSummary(c.education);
      row['Experience'] = experienceSummary(c.experience);
      row['Summary'] = c.summary || '';
      row['LinkedIn URL'] = c.linkedinUrl || '';
      row['Email'] = c.email || '';
      row['Phone'] = c.phone || '';
      row['Date Viewed'] = c.viewedDate || '';
      row['Source File'] = c.sourceFile || '';
      row['Parse Notes'] = (c.warnings || []).join(' ');
      return row;
    });

    var header = ['Name'];
    var colWidths = [{ wch: 22 }];
    if (keywordsActive) {
      header.push('Keyword Matches', 'Matched Keywords');
      colWidths.push({ wch: 14 }, { wch: 34 });
    }
    header = header.concat([
      'Headline', 'Location', 'Current Title', 'Current Company',
      'Top Skills', 'Languages', 'Certifications', 'Experience (approx.)',
      'Education', 'Experience', 'Summary', 'LinkedIn URL', 'Email', 'Phone',
      'Date Viewed', 'Source File', 'Parse Notes'
    ]);
    colWidths = colWidths.concat([
      { wch: 40 }, { wch: 24 }, { wch: 26 }, { wch: 22 },
      { wch: 34 }, { wch: 20 }, { wch: 34 }, { wch: 16 }, { wch: 50 },
      { wch: 60 }, { wch: 70 }, { wch: 38 }, { wch: 26 }, { wch: 18 },
      { wch: 14 }, { wch: 26 }, { wch: 40 }
    ]);

    var ws = XLSX.utils.json_to_sheet(rows, { header: header });
    ws['!cols'] = colWidths;
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

  function download(candidates, fileName, keywordsActive) {
    if (!window.XLSX) throw new Error('XLSX library failed to load.');
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildCandidatesSheet(candidates, keywordsActive), 'Candidates');
    XLSX.utils.book_append_sheet(wb, buildExperienceSheet(candidates), 'Experience');
    XLSX.utils.book_append_sheet(wb, buildSkillsSheet(candidates), 'Skills');
    var name = fileName || ('linkedin-candidates-' + timestamp() + '.xlsx');
    XLSX.writeFile(wb, name);
  }

  window.ExcelExport = { download: download };
})();
