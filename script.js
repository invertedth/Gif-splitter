// GIF Decoder - pure JS
function parseGIF(buf) {
  var data = new Uint8Array(buf);
  var p = 0;

  function r8() { return data[p++]; }
  function r16() { var v = data[p] | (data[p+1] << 8); p += 2; return v; }

  var sig = '';
  for (var i = 0; i < 6; i++) sig += String.fromCharCode(data[i]);
  if (sig.slice(0,3) !== 'GIF') throw new Error('Not a GIF');
  p = 6;

  var width  = r16();
  var height = r16();
  var packed = r8();
  r8(); r8(); // bg color idx, pixel aspect

  var gctFlag = (packed >> 7) & 1;
  var gctSize = packed & 0x07;
  var globalCT = null;
  if (gctFlag) {
    var n = 3 * (1 << (gctSize + 1));
    globalCT = data.slice(p, p + n);
    p += n;
  }

  var frames = [];
  var gce = { delay: 0, transparentIdx: -1, disposal: 0 };

  function readColorTable(size) {
    var n = 3 * (1 << (size + 1));
    var ct = data.slice(p, p + n);
    p += n;
    return ct;
  }

  function skipSubBlocks() {
    var len;
    while ((len = r8()) !== 0) p += len;
  }

  function readSubBlocks() {
    var chunks = [];
    var len;
    while ((len = r8()) !== 0) {
      chunks.push(data.slice(p, p + len));
      p += len;
    }
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  function lzwDecode(minCodeSize, input) {
    var clearCode = 1 << minCodeSize;
    var eoi       = clearCode + 1;
    var codeSize  = minCodeSize + 1;
    var codeMask  = (1 << codeSize) - 1;
    var nextCode  = eoi + 1;
    var table     = [];

    function initTable() {
      table = [];
      for (var i = 0; i < clearCode; i++) table.push([i]);
      table.push(null); // clear placeholder
      table.push(null); // eoi placeholder
    }
    initTable();

    var output   = [];
    var bits     = 0;
    var bitsLeft = 0;
    var byteIdx  = 0;
    var prev     = null;

    function readCode() {
      while (bitsLeft < codeSize && byteIdx < input.length) {
        bits |= input[byteIdx++] << bitsLeft;
        bitsLeft += 8;
      }
      var code = bits & codeMask;
      bits = bits >>> codeSize;
      bitsLeft -= codeSize;
      return code;
    }

    while (true) {
      var code = readCode();
      if (code === eoi) break;
      if (code === clearCode) {
        initTable();
        codeSize = minCodeSize + 1;
        codeMask = (1 << codeSize) - 1;
        nextCode = eoi + 1;
        prev = null;
        continue;
      }
      var entry;
      if (code < table.length && table[code] !== null) {
        entry = table[code];
      } else if (code === nextCode && prev !== null) {
        entry = prev.concat(prev[0]);
      } else {
        break;
      }
      for (var i = 0; i < entry.length; i++) output.push(entry[i]);
      if (prev !== null && nextCode < 4096) {
        table[nextCode++] = prev.concat(entry[0]);
        if (nextCode > codeMask + 1 && codeSize < 12) {
          codeSize++;
          codeMask = (1 << codeSize) - 1;
        }
      }
      prev = entry;
    }
    return new Uint8Array(output);
  }

  while (p < data.length) {
    var block = r8();
    if (block === 0x3B) break;

    if (block === 0x21) {
      var label = r8();
      if (label === 0xF9) {
        r8();
        var epacked = r8();
        gce.disposal       = (epacked >> 3) & 0x07;
        var tFlag          = epacked & 0x01;
        gce.delay          = r16() * 10;
        gce.transparentIdx = tFlag ? r8() : -1;
        if (!tFlag) r8();
        r8();
      } else {
        skipSubBlocks();
      }
      continue;
    }

    if (block === 0x2C) {
      var ix = r16(), iy = r16(), iw = r16(), ih = r16();
      var ipacked   = r8();
      var lctFlag   = (ipacked >> 7) & 1;
      var interlace = (ipacked >> 6) & 1;
      var lctSize   = ipacked & 0x07;

      var ct = globalCT;
      if (lctFlag) ct = readColorTable(lctSize);

      var minCodeSize = r8();
      var lzwData     = readSubBlocks();
      var indices     = lzwDecode(minCodeSize, lzwData);

      var finalIdx = indices;
      if (interlace) {
        finalIdx = new Uint8Array(iw * ih);
        var passes = [
          { start: 0, step: 8 },
          { start: 4, step: 8 },
          { start: 2, step: 4 },
          { start: 1, step: 2 }
        ];
        var src = 0;
        for (var pi = 0; pi < passes.length; pi++) {
          for (var row = passes[pi].start; row < ih; row += passes[pi].step) {
            for (var col = 0; col < iw; col++) {
              finalIdx[row * iw + col] = indices[src++];
            }
          }
        }
      }

      frames.push({
        x: ix, y: iy, width: iw, height: ih,
        indices: finalIdx,
        colorTable: ct,
        transparentIdx: gce.transparentIdx,
        disposal: gce.disposal,
        delay: gce.delay
      });

      gce = { delay: 0, transparentIdx: -1, disposal: 0 };
      continue;
    }

    skipSubBlocks();
  }

  return { width: width, height: height, frames: frames };
}

function renderFrames(gif) {
  var width   = gif.width;
  var height  = gif.height;
  var frames  = gif.frames;

  var composite = document.createElement('canvas');
  composite.width  = width;
  composite.height = height;
  var ctx = composite.getContext('2d');

  var results      = [];
  var prevSnapshot = null;

  for (var i = 0; i < frames.length; i++) {
    var f = frames[i];

    if (i > 0) {
      var prev = frames[i - 1];
      if (prev.disposal === 2) {
        ctx.clearRect(prev.x, prev.y, prev.width, prev.height);
      } else if (prev.disposal === 3 && prevSnapshot) {
        ctx.putImageData(prevSnapshot, 0, 0);
      }
    }

    if (f.disposal === 3) {
      prevSnapshot = ctx.getImageData(0, 0, width, height);
    }

    var ct = f.colorTable;
    var id = ctx.createImageData(f.width, f.height);
    var px = id.data;
    for (var j = 0; j < f.indices.length; j++) {
      var idx = f.indices[j];
      if (idx === f.transparentIdx) { px[j*4+3] = 0; continue; }
      px[j*4+0] = ct[idx*3+0];
      px[j*4+1] = ct[idx*3+1];
      px[j*4+2] = ct[idx*3+2];
      px[j*4+3] = 255;
    }
    ctx.putImageData(id, f.x, f.y);

    var snap = document.createElement('canvas');
    snap.width  = width;
    snap.height = height;
    snap.getContext('2d').drawImage(composite, 0, 0);
    results.push(snap);
  }

  return results;
}

// ZIP Builder - pure JS
function buildZip(entries) {
  var parts      = [];
  var centralDir = [];
  var offset     = 0;

  function crc32(buf) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (var k = 0; k < 8; k++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function u16(v) { var b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
  function u32(v) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }

  for (var i = 0; i < entries.length; i++) {
    var e    = entries[i];
    var name = new TextEncoder().encode(e.name);
    var crc  = crc32(e.data);
    var local = concat([
      new Uint8Array([0x50,0x4B,0x03,0x04]),
      u16(20), u16(0), u16(0),
      u16(0),  u16(0),
      u32(crc),
      u32(e.data.length),
      u32(e.data.length),
      u16(name.length), u16(0),
      name, e.data
    ]);
    centralDir.push({ name: name, crc: crc, size: e.data.length, offset: offset });
    parts.push(local);
    offset += local.length;
  }

  var cdStart = offset;
  for (var i = 0; i < centralDir.length; i++) {
    var cd    = centralDir[i];
    var entry = concat([
      new Uint8Array([0x50,0x4B,0x01,0x02]),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(cd.crc),
      u32(cd.size), u32(cd.size),
      u16(cd.name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(cd.offset),
      cd.name
    ]);
    parts.push(entry);
  }

  var cdSize = 0;
  for (var i = 0; i < parts.length; i++) cdSize += parts[i].length;
  cdSize -= cdStart;

  var eocd = concat([
    new Uint8Array([0x50,0x4B,0x05,0x06]),
    u16(0), u16(0),
    u16(centralDir.length), u16(centralDir.length),
    u32(cdSize), u32(cdStart),
    u16(0)
  ]);
  parts.push(eocd);

  return concat(parts);
}

function concat(arrays) {
  var total = 0;
  for (var i = 0; i < arrays.length; i++) total += arrays[i].length;
  var out = new Uint8Array(total);
  var off = 0;
  for (var i = 0; i < arrays.length; i++) { out.set(arrays[i], off); off += arrays[i].length; }
  return out;
}

// UI
var dropzone   = document.getElementById('dropzone');
var fileInput  = document.getElementById('fileInput');
var queue      = document.getElementById('queue');
var queuePanel = document.getElementById('queuePanel');
var runBtn     = document.getElementById('runBtn');
var outGrid    = document.getElementById('outGrid');
var outputWrap = document.getElementById('outputWrap');
var progWrap   = document.getElementById('progressWrap');
var progFill   = document.getElementById('progFill');
var progLabel  = document.getElementById('progLabel');
var dlAllBtn   = document.getElementById('dlAllBtn');
var statRow    = document.getElementById('statRow');
var clearBtn   = document.getElementById('clearBtn');
var errMsg     = document.getElementById('errMsg');

var files           = [];
var allFrameEntries = [];

dropzone.addEventListener('dragover', function(e) { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', function() { dropzone.classList.remove('drag'); });
dropzone.addEventListener('drop', function(e) { e.preventDefault(); dropzone.classList.remove('drag'); addFiles(Array.from(e.dataTransfer.files)); });
dropzone.addEventListener('click', function() { fileInput.click(); });
fileInput.addEventListener('change', function() { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });

clearBtn.addEventListener('click', function() {
  files = []; allFrameEntries = [];
  queue.innerHTML = '';
  queuePanel.style.display = 'none';
  outputWrap.style.display = 'none';
  outGrid.innerHTML = ''; statRow.innerHTML = '';
  progWrap.style.display = 'none';
  runBtn.disabled = true;
  errMsg.style.display = 'none';
});

function addFiles(newFiles) {
  var gifs = newFiles.filter(function(f) {
    return f.type === 'image/gif' || f.name.toLowerCase().endsWith('.gif');
  });
  if (!gifs.length) { showErr('No valid .gif files found.'); return; }
  errMsg.style.display = 'none';
  gifs.forEach(function(f) { files.push(f); addQueueItem(f, files.length - 1); });
  queuePanel.style.display = 'block';
  runBtn.disabled = false;
}

function addQueueItem(file, idx) {
  var li  = document.createElement('li');
  li.id   = 'qitem-' + idx;
  var url = URL.createObjectURL(file);
  li.innerHTML =
    '<img class="q-thumb" src="' + url + '">' +
    '<span class="q-name">' + escHtml(file.name) + '</span>' +
    '<span class="q-frames" id="qframes-' + idx + '">-</span>' +
    '<span class="q-status waiting" id="qstatus-' + idx + '">WAITING</span>';
  queue.appendChild(li);
}

function setStatus(idx, cls, text) {
  var el = document.getElementById('qstatus-' + idx);
  if (el) { el.className = 'q-status ' + cls; el.textContent = text; }
}

function showErr(msg) { errMsg.textContent = msg; errMsg.style.display = 'block'; }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function canvasToUint8Array(canvas) {
  return new Promise(function(resolve) {
    canvas.toBlob(function(blob) {
      blob.arrayBuffer().then(function(buf) { resolve(new Uint8Array(buf)); });
    }, 'image/png');
  });
}

runBtn.addEventListener('click', async function() {
  runBtn.disabled = true;
  outGrid.innerHTML = '';
  allFrameEntries = [];
  outputWrap.style.display = 'none';
  errMsg.style.display = 'none';

  var prefix     = document.getElementById('prefix').value.trim() || 'ttm';
  var startIndex = parseInt(document.getElementById('startIndex').value) || 1;
  var counter    = startIndex;
  var totalFrames = 0, processedFrames = 0;

  progWrap.style.display = 'block';
  progFill.style.width   = '0%';
  progLabel.textContent  = 'Parsing GIFs...';
  await sleep(0);

  var parsed = [];
  for (var i = 0; i < files.length; i++) {
    setStatus(i, 'running', 'PARSING');
    try {
      var buf = await files[i].arrayBuffer();
      var gif = parseGIF(buf);
      totalFrames += gif.frames.length;
      document.getElementById('qframes-' + i).textContent = gif.frames.length + ' fr';
      parsed.push({ gif: gif, idx: i });
    } catch(e) {
      setStatus(i, 'error', 'ERROR');
      document.getElementById('qframes-' + i).textContent = 'failed';
      console.error(files[i].name, e);
      parsed.push(null);
    }
  }

  for (var i = 0; i < parsed.length; i++) {
    var item = parsed[i];
    if (!item) continue;
    setStatus(item.idx, 'running', 'RENDERING');
    await sleep(0);

    var canvases;
    try {
      canvases = renderFrames(item.gif);
    } catch(e) {
      setStatus(item.idx, 'error', 'ERROR');
      console.error(e);
      continue;
    }

    for (var f = 0; f < canvases.length; f++) {
      var name = prefix + counter + '.png';
      counter++;
      var data = await canvasToUint8Array(canvases[f]);
      allFrameEntries.push({ name: name, data: data });

      var card = document.createElement('div');
      card.className = 'frame-card';
      var url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
      card.innerHTML = '<img src="' + url + '" loading="lazy"><div class="frame-name">' + name + '</div>';
      outGrid.appendChild(card);

      processedFrames++;
      var pct = totalFrames > 0 ? Math.round(processedFrames / totalFrames * 100) : 0;
      progFill.style.width   = pct + '%';
      progLabel.textContent  = processedFrames + ' / ' + totalFrames + ' frames (' + pct + '%)';

      if (f % 5 === 0) await sleep(0);
    }

    setStatus(item.idx, 'done', 'DONE');
  }

  progFill.style.width  = '100%';
  progLabel.textContent = allFrameEntries.length + ' frames extracted';

  outputWrap.style.display = 'block';
  statRow.innerHTML =
    '<div class="stat"><span>' + allFrameEntries.length + '</span> frames</div>' +
    '<div class="stat"><span>' + files.length + '</span> GIFs</div>' +
    '<div class="stat"><span>' + prefix + startIndex + '</span> to <span>' + prefix + (counter - 1) + '</span></div>';

  runBtn.disabled = false;
});

dlAllBtn.addEventListener('click', async function() {
  if (!allFrameEntries.length) return;
  dlAllBtn.textContent = 'Building ZIP...';
  dlAllBtn.disabled    = true;
  await sleep(0);

  try {
    var zip  = buildZip(allFrameEntries);
    var blob = new Blob([zip], { type: 'application/zip' });
    var a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'gif_frames.zip';
    a.click();
  } catch(e) {
    console.error(e);
    showErr('ZIP failed: ' + e.message);
  }

  dlAllBtn.textContent = 'Download All Frames as ZIP';
  dlAllBtn.disabled    = false;
});
