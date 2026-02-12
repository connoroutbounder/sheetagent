/**
 * ============================================================
 * SheetContext.gs — Sheet Intelligence Layer
 * ============================================================
 * Reads and structures the active sheet's data so the AI agent
 * can understand what it's looking at. Captures headers, data
 * types, sample values, row counts, and selection state.
 */

const SheetContext = {

  /**
   * Captures a full snapshot of the active sheet's structure and data.
   * This is the primary context object sent to the backend.
   * 
   * @returns {Object} Complete sheet context
   */
  capture: function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = SpreadsheetApp.getActiveSheet();
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    if (values.length === 0) {
      return {
        spreadsheetId: ss.getId(),
        spreadsheetName: ss.getName(),
        sheetName: sheet.getName(),
        sheetId: sheet.getSheetId(),
        isEmpty: true,
        headers: [],
        rowCount: 0,
        columnCount: 0,
        columns: [],
        sampleRows: [],
        allSheets: this._getAllSheetNames(ss),
      };
    }
    
    const headers = values[0].map(function(h, i) {
      return {
        index: i,
        letter: SheetContext._colLetter(i),
        name: String(h).trim() || ('Column ' + SheetContext._colLetter(i)),
        raw: h,
      };
    });
    
    const dataRows = values.slice(1);
    const columns = this._analyzeColumns(headers, dataRows);
    const sampleRows = this._getSampleRows(headers, dataRows, 5);
    const emptyOutputRows = this._findEmptyOutputRows(headers, dataRows, columns);
    
    return {
      spreadsheetId: ss.getId(),
      spreadsheetName: ss.getName(),
      sheetName: sheet.getName(),
      sheetId: sheet.getSheetId(),
      isEmpty: false,
      headers: headers,
      rowCount: dataRows.length,
      columnCount: headers.length,
      columns: columns,
      sampleRows: sampleRows,
      emptyOutputRows: emptyOutputRows,
      allSheets: this._getAllSheetNames(ss),
      namedRanges: this._getNamedRanges(ss),
    };
  },

  /**
   * Gets context about the current selection.
   * Useful for "process selected rows" commands.
   * 
   * @returns {Object} Selection context
   */
  getSelection: function() {
    const sheet = SpreadsheetApp.getActiveSheet();
    const selection = sheet.getActiveRange();
    
    if (!selection) {
      return { hasSelection: false };
    }
    
    const values = selection.getValues();
    const startRow = selection.getRow();
    const startCol = selection.getColumn();
    
    return {
      hasSelection: true,
      range: selection.getA1Notation(),
      startRow: startRow,
      startCol: startCol,
      numRows: selection.getNumRows(),
      numCols: selection.getNumColumns(),
      values: values,
      isFullRows: startCol === 1 && selection.getNumColumns() === sheet.getLastColumn(),
    };
  },

  /**
   * Reads specific rows by their row numbers (1-indexed, including header).
   * Used by the backend to get fresh data before processing.
   * 
   * @param {number[]} rowNumbers - Array of row numbers to read
   * @returns {Object[]} Array of row data objects
   */
  readRows: function(rowNumbers) {
    const sheet = SpreadsheetApp.getActiveSheet();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    return rowNumbers.map(function(rowNum) {
      const values = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
      const row = {};
      headers.forEach(function(header, i) {
        row[String(header).trim()] = values[i];
      });
      row._rowNumber = rowNum;
      return row;
    });
  },

  /**
   * Gets a specific column's values (excluding header).
   * 
   * @param {string} columnLetter - e.g., "A", "B", "C"
   * @returns {any[]} Column values
   */
  getColumn: function(columnLetter) {
    const sheet = SpreadsheetApp.getActiveSheet();
    const colIndex = this._colIndex(columnLetter);
    const lastRow = sheet.getLastRow();
    
    if (lastRow < 2) return [];
    
    return sheet.getRange(2, colIndex + 1, lastRow - 1, 1)
      .getValues()
      .map(function(row) { return row[0]; });
  },

  // ===========================================================
  // PRIVATE HELPERS
  // ===========================================================

  /**
   * Analyzes each column to detect data types, fill rates, patterns.
   */
  _analyzeColumns: function(headers, dataRows) {
    return headers.map(function(header, colIdx) {
      const values = dataRows.map(function(row) { return row[colIdx]; });
      const nonEmpty = values.filter(function(v) { return v !== '' && v !== null && v !== undefined; });
      
      // Detect data type
      const types = {};
      nonEmpty.forEach(function(v) {
        let type = typeof v;
        if (v instanceof Date) type = 'date';
        else if (type === 'string' && SheetContext._isUrl(v)) type = 'url';
        else if (type === 'string' && SheetContext._isEmail(v)) type = 'email';
        types[type] = (types[type] || 0) + 1;
      });
      
      const primaryType = Object.keys(types).sort(function(a, b) { return types[b] - types[a]; })[0] || 'empty';
      
      // Detect if this looks like an output column (mostly empty, after filled columns)
      const fillRate = nonEmpty.length / Math.max(dataRows.length, 1);
      const looksLikeOutput = fillRate < 0.3 && colIdx > 0;
      
      // Detect if this looks like a status column
      const uniqueValues = [...new Set(nonEmpty.map(String))];
      const looksLikeStatus = uniqueValues.length <= 5 && nonEmpty.length > 0 && 
        uniqueValues.some(function(v) {
          const lower = v.toLowerCase();
          return lower.includes('pending') || lower.includes('complete') || lower.includes('done') || 
                 lower.includes('running') || lower.includes('error') || lower.includes('queued');
        });

      // Detect if this looks like an instruction column
      const avgLength = nonEmpty.reduce(function(sum, v) { return sum + String(v).length; }, 0) / Math.max(nonEmpty.length, 1);
      const looksLikeInstruction = primaryType === 'string' && avgLength > 15 && 
        header.name.toLowerCase().match(/instruction|task|prompt|what|query|question|ask/);
      
      return {
        index: colIdx,
        letter: header.letter,
        name: header.name,
        type: primaryType,
        fillRate: Math.round(fillRate * 100),
        totalRows: dataRows.length,
        filledRows: nonEmpty.length,
        emptyRows: dataRows.length - nonEmpty.length,
        uniqueValues: uniqueValues.length,
        sampleValues: nonEmpty.slice(0, 3).map(String),
        looksLikeOutput: looksLikeOutput,
        looksLikeStatus: looksLikeStatus,
        looksLikeInstruction: looksLikeInstruction,
      };
    });
  },

  /**
   * Gets sample rows for the agent to understand data patterns.
   */
  _getSampleRows: function(headers, dataRows, count) {
    const samples = dataRows.slice(0, count);
    return samples.map(function(row, rowIdx) {
      const obj = { _rowNumber: rowIdx + 2 }; // +2 for 1-indexed + header
      headers.forEach(function(header, colIdx) {
        obj[header.name] = row[colIdx];
      });
      return obj;
    });
  },

  /**
   * Finds rows that need processing (have input data but empty output).
   */
  _findEmptyOutputRows: function(headers, dataRows, columns) {
    const outputCols = columns.filter(function(c) { return c.looksLikeOutput; });
    if (outputCols.length === 0) return { count: 0, rows: [] };
    
    const outputColIdx = outputCols[0].index;
    const inputCols = columns.filter(function(c) { return !c.looksLikeOutput && !c.looksLikeStatus && c.fillRate > 50; });
    
    const emptyRows = [];
    dataRows.forEach(function(row, idx) {
      const hasInput = inputCols.some(function(col) {
        return row[col.index] !== '' && row[col.index] !== null;
      });
      const hasOutput = row[outputColIdx] !== '' && row[outputColIdx] !== null;
      
      if (hasInput && !hasOutput) {
        emptyRows.push(idx + 2); // 1-indexed + header row
      }
    });
    
    return {
      count: emptyRows.length,
      rows: emptyRows.slice(0, 100), // Cap to prevent huge payloads
      outputColumn: outputCols[0].letter,
    };
  },

  /**
   * Gets all sheet names in the spreadsheet.
   */
  _getAllSheetNames: function(ss) {
    return ss.getSheets().map(function(s) {
      return { name: s.getName(), id: s.getSheetId(), rowCount: s.getLastRow() };
    });
  },

  /**
   * Gets named ranges.
   */
  _getNamedRanges: function(ss) {
    try {
      return ss.getNamedRanges().map(function(nr) {
        return { name: nr.getName(), range: nr.getRange().getA1Notation() };
      });
    } catch(e) {
      return [];
    }
  },

  /**
   * Converts column index (0-based) to letter.
   */
  _colLetter: function(index) {
    let letter = '';
    let temp = index;
    while (temp >= 0) {
      letter = String.fromCharCode((temp % 26) + 65) + letter;
      temp = Math.floor(temp / 26) - 1;
    }
    return letter;
  },

  /**
   * Converts column letter to index (0-based).
   */
  _colIndex: function(letter) {
    let index = 0;
    for (let i = 0; i < letter.length; i++) {
      index = index * 26 + (letter.charCodeAt(i) - 64);
    }
    return index - 1;
  },

  /**
   * Checks if a value looks like a URL.
   */
  _isUrl: function(v) {
    return /^https?:\/\/|^www\.|\.com$|\.io$|\.org$|\.net$/i.test(String(v));
  },

  /**
   * Checks if a value looks like an email.
   */
  _isEmail: function(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v));
  },
};
