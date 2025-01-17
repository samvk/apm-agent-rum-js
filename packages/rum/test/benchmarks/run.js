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

const { join } = require('path')
const { writeFileSync } = require('fs')
const { gatherRawMetrics, launchBrowser } = require('./profiler')
const {
  analyzeMetrics,
  calculateResults,
  getCommonFields
} = require('./analyzer')
const { runs, port, scenarios } = require('./config')
const startServer = require('./server')

const REPORTS_DIR = join(__dirname, '../../reports')

!(async function run() {
  try {
    const server = await startServer()
    /**
     * object cache holding the metrics accumlated in each run and
     * helps in processing the overall results
     */
    const resultMap = new Map()

    for (let scenario of scenarios) {
      const browser = await launchBrowser()
      const url = `http://localhost:${port}/${scenario}`
      const version = await browser.version()

      /**
       * Add common set of metrics for all scenarios
       */
      resultMap.set(scenario, getCommonFields({ version, url, scenario }))

      for (let i = 0; i < runs; i++) {
        const metrics = await gatherRawMetrics(browser, url)
        Object.assign(metrics, { scenario, url })
        await analyzeMetrics(metrics, resultMap)
      }
      await browser.close()
    }

    server.close()

    const results = calculateResults(resultMap)

    console.log(
      '@elastic/apm-rum benchmarks',
      JSON.stringify(results, undefined, 2)
    )

    const filePath = join(REPORTS_DIR, 'rum-benchmarks.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        type: 'eum',
        summary: results
      })
    )

    console.log('RUM benchmark results written to disk', filePath)
  } catch (e) {
    console.error('Error running RUM benchmark script', e)
  }
})()
