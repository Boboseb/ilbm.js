"use strict";

function Ilbm(img) {
  this.status = 0;
  this.img = img;
  this.chunks = [];
  this.cmap = [];
  this.width = 0;
  this.dataWidth = 0;
  this.height = 0;
  this.dataHeight = 0;
  this.depth = 0;
  this.mask = 0;
  this.rle = false;
  this.ham = false;
  this.ehb = false;
  this.xAspect = 1;
  this.yAspect = 1;
  this.expandY = false;
}

Ilbm.UNLOADED = 0;
Ilbm.LOADING = 1;
Ilbm.LOADED = 2;
Ilbm.BMHDOK = 3;
Ilbm.DECODING = 4;
Ilbm.READY = 5;

Ilbm.toFourCC = function(uint8View) {
    return String.fromCharCode(uint8View[0], uint8View[1], uint8View[2], uint8View[3]);
  };

Ilbm.chunkProcessors = {
  "BMHD": function (ilbm) {
    var data = this.data;
    var offset = 0;

    ilbm.dataWidth = data.getUint16(offset);
    ilbm.width = ilbm.dataWidth;
    offset += 2;
    ilbm.dataHeight = data.getUint16(offset);
    ilbm.height = ilbm.dataHeight;
    offset += 6;

    ilbm.depth = data.getUint8(offset);
    offset += 1;
    ilbm.mask = data.getUint8(offset) == 1 ? 1 : 0;
    offset += 1;
    ilbm.rle = data.getUint8(offset) == 1;

    // Skip compression, pad1 and transparentColor
    offset += 4;
    ilbm.xAspect = data.getUint8(offset);
    if (ilbm.xAspect == 0) ilbm.xAspect = 1;

    offset += 1;
    ilbm.yAspect = data.getUint8(offset);
    if (ilbm.yAspect == 0) ilbm.yAspect = 1;

    ilbm.status = Ilbm.BMHDOK;
  },
  "CMAP": function (ilbm) {
    if (ilbm.status != Ilbm.BMHDOK) throw "Bad IFF ILBM";
    var length = this.size / 3;
    var buffer = this.data.buffer;
    var offset = this.data.byteOffset;
    for (var i = 0; i < length; ++i) {
      ilbm.cmap[i] = new Uint8Array(buffer, offset, 3);
      offset += 3;
    }
  },
  "CAMG": function (ilbm) {
    if (ilbm.status != Ilbm.BMHDOK) throw "Bad IFF ILBM";
    var flags = this.data.getInt32(0);
    if (flags & 0x800) {
      ilbm.ham = true;
    }
    else if (flags & 0x80) {
      ilbm.ehb = true;
    }
    if ((flags & 0x8000) && !(flags & 0x4)) {
      ilbm.expandY = true;
      ilbm.height = 2 * ilbm.dataHeight;
    }
    else if ((flags & 0x4) && ! (flags & 0x8000)) {
        ilbm.expandX = true;
        ilbm.width = 2 * ilbml.dataWidth;
    }
  },
  "BODY": function (ilbm) {
    if (ilbm.status != Ilbm.BMHDOK) throw "Bad IFF ILBM";

    if (ilbm.ehb) {
      // EHB mode, extends CMAP
      var newColor;
      var cmapLength = ilbm.cmap.length;
      for (var i = 0; i < cmapLength; ++i) {
        newColor = new Uint8Array(ilbm.cmap[i]);
        newColor[0] >>= 1;
        newColor[1] >>= 1;
        newColor[2] >>= 1;
        ilbm.cmap.push(newColor);
      }
    }
    ilbm.status = Ilbm.DECODING;

    ilbm.createCanvas();
    ilbm.decodeAndDraw(this.data);
    ilbm.updateImg();
  }
};

Ilbm.getBit = function(array, col) {
  var byteOffset = col / 8 | 0;
  var bitOffset = 7 - col % 8;
  var byteVal = array[byteOffset];
  return (byteVal >> bitOffset) & 1;
};

Ilbm.unpackRow = function(rawData, planerowSize, decodedRowPlanes) {
  var tmpSubView;
  var tmpValue;
  var rawIdx = 0;
  var colIdx;
  var n;
  for (var p = 0; p < decodedRowPlanes.length; ++p) {
    colIdx = 0;
    while (colIdx < planerowSize) {
      n = rawData[rawIdx++];
      if (n <= 127) {
        n = n + 1;
        if (colIdx + n > planerowSize) n = planerowSize - colIdx;
        tmpSubView = rawData.subarray(rawIdx, rawIdx + n);
        rawIdx += n;
        decodedRowPlanes[p].set(tmpSubView, colIdx);
        colIdx += n;
      }
      else {
        n = 257 - n;
        tmpValue = rawData[rawIdx++];
        while (n-- > 0) {
          decodedRowPlanes[p][colIdx++] = tmpValue;
        }
      }
    }
  }
  return rawIdx;
};

Ilbm.prototype = {

  readChunk: function(view) {
    var buffer = view.buffer;
    var offset = view.byteOffset;
    var chunk = {};

    chunk.id = Ilbm.toFourCC(new Uint8Array(buffer, offset, 4));

    chunk.process = Ilbm.chunkProcessors[chunk.id] || function () {};

    chunk.size = view.getInt32(4);

    chunk.data = new DataView(buffer, offset + 8, chunk.size);

    chunk.fullSize = chunk.size + 8;
    if (chunk.size % 2 != 0) chunk.fullSize++;

    return chunk;
  },

  decodeAndDraw: function(data) {
    var buffer = data.buffer;
    var offset = data.byteOffset;
    var rawData = new Uint8Array(buffer, offset, data.byteLength);
    var planerowSize = (this.dataWidth + 15) / 16 << 1;
    var nbPlanes = this.depth + this.mask;
    var p;

    var context = this.canvas.getContext("2d");
    var imageData = context.createImageData(this.width, this.height);
    var pixelArray = imageData.data;

    // Allocate temp buffer for decoded row
    var decodedRowPlanes = new Array(nbPlanes);
    if (this.rle) {
      var tmpPlanesBuffer = new ArrayBuffer(planerowSize * (nbPlanes));
      for (p = 0; p < nbPlanes; ++p) {
        decodedRowPlanes[p] = new Uint8Array(tmpPlanesBuffer, p * planerowSize, planerowSize);
      }
    }

    for (var rowIdx = 0; rowIdx < this.dataHeight; ++rowIdx) {
      if (!this.rle) {
        for (p = 0; p < nbPlanes; ++p) {
          decodedRowPlanes[p] = new Uint8Array(buffer, offset, planerowSize);
          offset += planerowSize;
        }
      }
      else {
        rawData = rawData.subarray(Ilbm.unpackRow(rawData, planerowSize, decodedRowPlanes));
      }
      // Draw
      this.drawRow(decodedRowPlanes, rowIdx, 0, pixelArray);
    }

    context.putImageData(imageData, 0, 0);
  },

  drawRow: function(decodedRowPlanes, rowIdx, left, pixelArray) {

    var rowOffset = rowIdx * this.width * 4;
    var offset;
    var p;
    var depth = this.depth;
    var masking = this.mask == 1;
    var value;
    var holdValue;
    var hamMask = 0;
    var hamShift = 0;
    var hamKey;
    if (this.ham) {
      hamMask = depth == 6 ? 0x0F : 0x3F;
      hamShift = depth - 2;
    }

    if (this.expandY) rowOffset = rowOffset * 2;

    offset = rowOffset + left;

    for (var col = left; (col < this.dataWidth) && (left + col < this.width); ++col) {

      if (masking && Ilbm.getBit(decodedRowPlanes[depth], col) != 1) {
        // Transparent pixel
        pixelArray[offset] = 0;
        pixelArray[offset + 1] = 0;
        pixelArray[offset + 2] = 0;
        pixelArray[offset + 3] = 0;
      }
      else {
        value = 0;
        for (p = 0; p < depth; ++p) {
          value += Ilbm.getBit(decodedRowPlanes[p], col) << p;
        }
        if (hamShift && (hamKey = (value >> hamShift))) {
          value = value & hamMask;
          value = (value << (8 - hamShift)) + (value >> (hamShift - (8 - hamShift)));
          if (hamKey == 2) {
            pixelArray[offset] = value;
          }
          else {
            pixelArray[offset] = col != 0 ? pixelArray[offset - 4] : 0;
          }
          if (hamKey == 3) {
            pixelArray[offset + 1] = value;
          }
          else {
            pixelArray[offset + 1] = col != 0 ? pixelArray[offset - 3] : 0;
          }
          if (hamKey == 1) {
            pixelArray[offset + 2] = value;
          }
          else {
            pixelArray[offset + 2] = col != 0 ? pixelArray[offset - 2] : 0;
          }
        }
        else if (depth == 24) {
          pixelArray[offset] = value & 0xFF;
          pixelArray[offset + 1] = (value >> 8) & 0xFF;
          pixelArray[offset + 2] = (value >> 16) & 0xFF;
        }
        else {
          pixelArray.set(this.cmap[value], offset);
        }
        pixelArray[offset + 3] = 255;
      }
      offset += 4;
    }
    if (this.expandY) {
      // duplicate row
      var tmpSubarray = pixelArray.subarray(rowOffset, rowOffset + this.width * 4);
      pixelArray.set(tmpSubarray, rowOffset + this.width * 4);
    }
  },

  processBuffer: function(buffer) {
    var view = new DataView(buffer);

    // Check .info first
    var magic, version;
    magic = view.getUint16(0);
    version = view.getUint16(2);

    if (magic == 0xE310 && version == 1) {
      this.processInfoFile(view);
    }
    else {
      this.processILBM(view);
    }
  },

  processILBM: function(view) {
    var buffer = view.buffer;
    var offset = view.byteOffset;
    var form, size, ilbm;
    do {
      form = Ilbm.toFourCC(new Uint8Array(buffer, offset, 4));
      offset += 4;
      size = view.getInt32(offset);
      offset += 4;
      ilbm = Ilbm.toFourCC(new Uint8Array(buffer, offset, 4));
      offset += 4;
      if (("FORM" != form) || ("ILBM" != ilbm && "ANIM" != ilbm)) {
        throw "Bad IFF ILBM or ANIM";
      }
      // if ANIM, skip header until first FORM ILBM found
    } while ("ILBM" != ilbm);

    size = size - 4;
    var chunk;
    while (size > 0) {
      view = new DataView(buffer, offset, size);
      chunk = this.readChunk(view);
      this.chunks.push(chunk);

      offset += chunk.fullSize;
      size -= chunk.fullSize;

      chunk.process(this);
    }
    if (this.status != Ilbm.DECODING) throw "Bad IFF ILBM";
    this.status = Ilbm.READY;
  },

  processInfoFile: function(view) {
    this.width = view.getUint16(12);
    this.height = view.getUint16(14);
    var revision = view.getUint32(44);
    var hasDrawerData = !!view.getUint32(66);

    var buffer = view.buffer;
    var offset = view.byteOffset + 78;

    if (hasDrawerData) offset += 56;

    view = new DataView(buffer, offset, 20);

    var left = Math.max(view.getInt16(0), 0);
    var top = Math.max(view.getInt16(2), 0);
    this.dataWidth = view.getUint16(4);
    this.dataHeight = view.getUint16(6);
    this.depth = view.getUint16(8);

    offset += 20;

    var planerowSize = (this.dataWidth + 15) / 16 << 1;
    var planeSize = planerowSize * this.dataHeight;
    var nbPlanes = this.depth;
    var rawData = new Uint8Array(buffer, offset, planerowSize * this.dataHeight * nbPlanes);
    var p;

    var cmapBuffer;
    var color;
    var maxCol = 1 << nbPlanes;
    // create cmap
    if (revision == 0) {
      cmapBuffer = new ArrayBuffer(maxCol * 3);
      color = new Uint8Array(cmapBuffer, 0, 3);
      color[0] = 0x55;
      color[1] = 0xAA;
      color[2] = 0xFF;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 3, 3);
      color[0] = 0xFF;
      color[1] = 0xFF;
      color[2] = 0xFF;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 6, 3);
      color[0] = 0x00;
      color[1] = 0x00;
      color[2] = 0x00;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 9, 3);
      color[0] = 0xFF;
      color[1] = 0x88;
      color[2] = 0x00;
      this.cmap.push(color);
      for (p = 4; p < maxCol; ++p) {
        color = new Uint8Array(cmapBuffer, p * 3, 3);
        color[0] = color[1] = color[2] = (p - 4) * 255 / (maxCol - 5) | 0;
        this.cmap.push(color);
      }
    }
    else {
      cmapBuffer = new ArrayBuffer(24);
      color = new Uint8Array(cmapBuffer, 0, 3);
      color[0] = 0x95;
      color[1] = 0x95;
      color[2] = 0x95;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 3, 3);
      color[0] = 0x00;
      color[1] = 0x00;
      color[2] = 0x00;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 6, 3);
      color[0] = 0xFF;
      color[1] = 0xFF;
      color[2] = 0xFF;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 9, 3);
      color[0] = 0x3B;
      color[1] = 0x67;
      color[2] = 0xA2;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 12, 3);
      color[0] = 0x7B;
      color[1] = 0x7B;
      color[2] = 0x7B;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 15, 3);
      color[0] = 0xAF;
      color[1] = 0xAF;
      color[2] = 0xAF;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 18, 3);
      color[0] = 0xAA;
      color[1] = 0x90;
      color[2] = 0x7C;
      this.cmap.push(color);
      color = new Uint8Array(cmapBuffer, 21, 3);
      color[0] = 0xFF;
      color[1] = 0xA9;
      color[2] = 0x97;
      this.cmap.push(color);
    }

    this.createCanvas();
    var context = this.canvas.getContext("2d");
    var imageData = context.createImageData(this.width, this.height);
    var pixelArray = imageData.data;

    // Allocate temp buffer for decoded row
    var decodedRowPlanes = new Array(nbPlanes);

    for (var rowIdx = 0; rowIdx < this.dataHeight; ++rowIdx) {
      for (p = 0; p < nbPlanes; ++p) {
        decodedRowPlanes[p] = new Uint8Array(buffer, offset + rowIdx * planerowSize + p * planeSize, planerowSize);
      }
      // Draw
      this.drawRow(decodedRowPlanes, rowIdx + top, left, pixelArray);
    }

    context.putImageData(imageData, 0, 0);
  },

  createCanvas: function() {
    var document = this.img.ownerDocument;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  },

  updateImg: function() {
    this.img.dataset.origSrc = this.img.src;
    this.img.src = this.canvas.toDataURL();
    delete this.canvas;
  },
  
  load: function(callback) {
    var self = this;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', this.img.src);
    xhr.responseType = 'arraybuffer';
    xhr.onreadystatechange = function() {
      if (xhr.readyState == 4) {
        var buffer = xhr.response;
        self.processBuffer(buffer);
        if (callback instanceof Function) {
          callback(self);
        }
      }
    };
    xhr.send();
  }
};

