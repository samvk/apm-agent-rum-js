/**
 * MIT License
 *
 * Copyright (c) 2017-present, Elasticsearch BV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

import rng from 'uuid/lib/rng-browser'
import { Promise } from 'es6-promise'

const slice = [].slice

function isCORSSupported() {
  var xhr = new window.XMLHttpRequest()
  return 'withCredentials' in xhr
}

var byteToHex = []
for (var i = 0; i < 256; ++i) {
  byteToHex[i] = (i + 0x100).toString(16).substr(1)
}

function bytesToHex(buf, offset) {
  var i = offset || 0
  var bth = byteToHex
  // join used to fix memory issue caused by concatenation: https://bugs.chromium.org/p/v8/issues/detail?id=3175#c4
  return [
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]],
    bth[buf[i++]]
  ].join('')
}

function getDtHeaderValue(span) {
  const dtVersion = '00'
  const dtUnSampledFlags = '00'
  // 00000001 ->  '01' -> recorded
  const dtSampledFlags = '01'
  if (span && span.traceId && span.id && span.parentId) {
    var flags = span.sampled ? dtSampledFlags : dtUnSampledFlags
    /**
     * In the case of unsampled traces, propagate transaction id (parentId)
     * instead of span id to the downstream
     */
    var id = span.sampled ? span.id : span.parentId
    return dtVersion + '-' + span.traceId + '-' + id + '-' + flags
  }
}

function parseDtHeaderValue(value) {
  var parsed = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/.exec(
    value
  )
  if (parsed) {
    var flags = parsed[4]
    var sampled = flags !== '00'
    return {
      traceId: parsed[2],
      id: parsed[3],
      sampled
    }
  }
}

function isDtHeaderValid(header) {
  return (
    /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/.test(header) &&
    header.slice(3, 35) !== '00000000000000000000000000000000' &&
    header.slice(36, 52) !== '0000000000000000'
  )
}

function checkSameOrigin(source, target) {
  let isSame = false
  if (typeof target === 'string') {
    isSame = source === target
  } else if (Array.isArray(target)) {
    target.forEach(function(t) {
      if (!isSame) {
        isSame = checkSameOrigin(source, t)
      }
    })
  }
  return isSame
}

function generateRandomId(length) {
  var id = bytesToHex(rng())
  return id.substr(0, length)
}

function isPlatformSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof Array.prototype.forEach === 'function' &&
    typeof JSON.stringify === 'function' &&
    typeof Function.bind === 'function' &&
    window.performance &&
    typeof window.performance.now === 'function' &&
    isCORSSupported()
  )
}

/**
 * Convert values of the Tag/Label to be string to be compatible
 * with the apm server prior to <6.7 version
 *
 * TODO: Remove string conversion in the next major release since
 * support for boolean and number in the APM server has landed in 6.7
 * https://github.com/elastic/apm-server/pull/1712/
 */
function setLabel(key, value, obj) {
  if (!obj || !key) return
  var skey = removeInvalidChars(key)
  if (value) {
    value = String(value)
  }
  obj[skey] = value
  return obj
}

const navigationTimingKeys = [
  'fetchStart',
  'domainLookupStart',
  'domainLookupEnd',
  'connectStart',
  'connectEnd',
  'secureConnectionStart',
  'requestStart',
  'responseStart',
  'responseEnd',
  'domLoading',
  'domInteractive',
  'domContentLoadedEventStart',
  'domContentLoadedEventEnd',
  'domComplete',
  'loadEventStart',
  'loadEventEnd'
]

function getNavigationTimingMarks() {
  var timing = window.performance.timing
  var fetchStart = timing.fetchStart
  var marks = {}
  navigationTimingKeys.forEach(function(timingKey) {
    var m = timing[timingKey]
    if (m && m >= fetchStart) {
      marks[timingKey] = m - fetchStart
    }
  })
  return marks
}

/**
 * Paint Timing Metrics that is available during page load
 * https://www.w3.org/TR/paint-timing/
 */
function getPaintTimingMarks() {
  var paints = {}
  var perf = window.performance
  if (typeof perf.getEntriesByType === 'function') {
    var entries = perf.getEntriesByType('paint')
    if (entries.length > 0) {
      var timings = perf.timing
      /**
       * To avoid capturing the unload event handler effect in paint timings
       */
      var unloadDiff = timings.fetchStart - timings.navigationStart
      for (var i = 0; i < entries.length; i++) {
        var data = entries[i]
        var calcPaintTime =
          unloadDiff >= 0 ? data.startTime - unloadDiff : data.startTime
        paints[data.name] = calcPaintTime
      }
    }
  }
  return paints
}

/**
 *  Server timing information on Performance resource timing entries
 *  https://www.w3.org/TR/server-timing/
 *  [
 *    {
 *      name: "cdn-cache",
 *      duration: 0,
 *      desciprion: "HIT"
 *    },
 *    {
 *      name: "edge",
 *      duration: 4,
 *      desciption: ''
 *    }
 *  ]
 *  returns "cdn-cache;desc=HIT, edge;dur=4"
 */
function getServerTimingInfo(serverTimingEntries = []) {
  let serverTimingInfo = []
  const entrySeparator = ', '
  const valueSeparator = ';'
  for (let i = 0; i < serverTimingEntries.length; i++) {
    const { name, duration, description } = serverTimingEntries[i]
    let timingValue = name
    if (description) {
      timingValue += valueSeparator + 'desc=' + description
    }
    if (duration) {
      timingValue += valueSeparator + 'dur=' + duration
    }
    serverTimingInfo.push(timingValue)
  }
  return serverTimingInfo.join(entrySeparator)
}

function getTimeOrigin() {
  return window.performance.timing.fetchStart
}

function getPageMetadata() {
  return {
    page: {
      referer: document.referrer,
      url: window.location.href
    }
  }
}

function stripQueryStringFromUrl(url) {
  return url && url.split('?')[0]
}

function isObject(value) {
  // http://jsperf.com/isobject4
  return value !== null && typeof value === 'object'
}

function isFunction(value) {
  return typeof value === 'function'
}

function baseExtend(dst, objs, deep) {
  for (var i = 0, ii = objs.length; i < ii; ++i) {
    var obj = objs[i]
    if (!isObject(obj) && !isFunction(obj)) continue
    var keys = Object.keys(obj)
    for (var j = 0, jj = keys.length; j < jj; j++) {
      var key = keys[j]
      var src = obj[key]

      if (deep && isObject(src)) {
        if (!isObject(dst[key])) dst[key] = Array.isArray(src) ? [] : {}
        baseExtend(dst[key], [src], false) // only one level of deep merge
      } else {
        dst[key] = src
      }
    }
  }

  return dst
}

function getElasticScript() {
  if (typeof document !== 'undefined') {
    var scripts = document.getElementsByTagName('script')
    for (var i = 0, l = scripts.length; i < l; i++) {
      var sc = scripts[i]
      if (sc.src.indexOf('elastic') > 0) {
        return sc
      }
    }
  }
}

function getCurrentScript() {
  if (typeof document !== 'undefined') {
    // Source http://www.2ality.com/2014/05/current-script.html
    var currentScript = document.currentScript
    if (!currentScript) {
      return getElasticScript()
    }
    return currentScript
  }
}

function extend(dst) {
  return baseExtend(dst, slice.call(arguments, 1), false)
}

function merge(dst) {
  return baseExtend(dst, slice.call(arguments, 1), true)
}

function isUndefined(obj) {
  return typeof obj === 'undefined'
}

function noop() {}

function find(array, predicate, thisArg) {
  // Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/find
  if (array == null) {
    throw new TypeError('array is null or not defined')
  }

  var o = Object(array)
  var len = o.length >>> 0

  if (typeof predicate !== 'function') {
    throw new TypeError('predicate must be a function')
  }

  var k = 0

  while (k < len) {
    var kValue = o[k]
    if (predicate.call(thisArg, kValue, k, o)) {
      return kValue
    }
    k++
  }

  return undefined
}

function removeInvalidChars(key) {
  return key.replace(/[.*"]/g, '_')
}

function getLatestNonXHRSpan(spans) {
  let latestSpan = null
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    if (
      String(span.type).indexOf('external') === -1 &&
      (!latestSpan || latestSpan._end < span._end)
    ) {
      latestSpan = span
    }
  }
  return latestSpan
}

function getEarliestSpan(spans) {
  let earliestSpan = spans[0]
  for (let i = 1; i < spans.length; i++) {
    const span = spans[i]
    if (earliestSpan._start > span._start) {
      earliestSpan = span
    }
  }
  return earliestSpan
}

function getPageLoadMarks() {
  const marks = getNavigationTimingMarks()
  const paintMarks = getPaintTimingMarks()
  const agent = {
    timeToFirstByte: marks.responseStart,
    domInteractive: marks.domInteractive,
    domComplete: marks.domComplete
  }
  if (paintMarks['first-contentful-paint']) {
    agent.firstContentfulPaint = paintMarks['first-contentful-paint']
  }
  return {
    navigationTiming: marks,
    agent
  }
}

function now() {
  return window.performance.now()
}

function getTime(time) {
  return typeof time === 'number' && time >= 0 ? time : now()
}

function getDuration(start, end) {
  if (isUndefined(end) || isUndefined(start)) {
    return null
  }
  return parseFloat(end - start)
}

function scheduleMacroTask(callback) {
  Promise.resolve().then(callback)
}

export {
  extend,
  merge,
  isUndefined,
  noop,
  baseExtend,
  bytesToHex,
  isCORSSupported,
  isObject,
  isFunction,
  isPlatformSupported,
  isDtHeaderValid,
  parseDtHeaderValue,
  getNavigationTimingMarks,
  getPaintTimingMarks,
  getServerTimingInfo,
  getDtHeaderValue,
  getPageMetadata,
  getCurrentScript,
  getElasticScript,
  getTimeOrigin,
  generateRandomId,
  getEarliestSpan,
  getLatestNonXHRSpan,
  getPageLoadMarks,
  getDuration,
  now,
  getTime,
  rng,
  checkSameOrigin,
  scheduleMacroTask,
  setLabel,
  stripQueryStringFromUrl,
  find,
  removeInvalidChars
}
