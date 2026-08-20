import { describe, expect, it } from 'vitest'
import { parseChartSpec } from './chartSpec'
import { createIngestor, heuristicBreakdown } from './chartIngest'

/** Real `vmstat 1` output: two header rows, then one sample per second. */
const VMSTAT = `procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 2  0      0 5765160 121980 1899888    0    0    18    23  102  210  4  1 95  0  0
 1  0      0 5764656 121980 1899888    0    0     0     0  843 1620 12  3 85  0  0
 0  0      0 5764404 121980 1899888    0    0     0     0  711 1402  7  2 91  0  0
 0  0      0 5764404 121980 1899920    0    0     0    16  690 1355  3  1 96  0  0`

/** Real `free -m -s 1` output: a header, a Mem: row and a Swap: row per sample. */
const FREE = `               total        used        free      shared  buff/cache   available
Mem:            7847        1512        4210         168        2124        5904
Swap:           2047           0        2047
               total        used        free      shared  buff/cache   available
Mem:            7847        1602        4120         168        2124        5814
Swap:           2047           0        2047`

const PING = `PING example.com (93.184.216.34) 56(84) bytes of data.
64 bytes from 93.184.216.34: icmp_seq=1 ttl=56 time=12.3 ms
64 bytes from 93.184.216.34: icmp_seq=2 ttl=56 time=11.8 ms
64 bytes from 93.184.216.34: icmp_seq=3 ttl=56 time=13.1 ms`

/** `du -h --max-depth=1 /var | sort -rh | head -5`, grand total first. */
const DU = `1.4G\t.
900M\t./log
420M\t./lib
64M\t./cache`

const DF = `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       457G  221G  213G  51% /
tmpfs           3.9G  2.1M  3.9G   1% /dev/shm
/dev/sdb1       1.8T  1.1T  620G  65% /mnt/data`

const spec = (raw: Record<string, unknown>): ReturnType<typeof parseChartSpec> =>
  parseChartSpec(JSON.stringify(raw))

describe('createIngestor — tabular time series', () => {
  it('resolves a header-labelled column and drops the cumulative first sample', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'live',
        x: 'time',
        maxPoints: 60,
        series: [{ name: 'usage', column: 'id', transform: '100 - x' }]
      }),
      { command: 'vmstat 1' }
    )
    ing.ingestText(VMSTAT)

    // Four data rows arrive; the first (since-boot average) is discarded.
    expect(ing.points[0].map(([, y]) => y)).toEqual([15, 9, 4])
    expect(ing.stats.headerLines).toBe(1)
    expect(ing.stats.pointsPlotted).toBe(3)
    // Only vmstat's decorative banner fails to match — no data row does.
    expect(ing.stats.unmatched).toEqual([VMSTAT.split('\n')[0]])
  })

  it('plots the raw idle column when no transform is given', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'live',
        x: 'time',
        maxPoints: 60,
        series: [{ name: 'idle', column: 'id' }]
      })
    )
    ing.ingestText(VMSTAT)
    expect(ing.points[0].map(([, y]) => y)).toEqual([85, 91, 96])
  })

  it('keeps every sample when the spec is not a live column time series', () => {
    // A static spec has no cumulative first row to discard.
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'static',
        x: 'index',
        maxPoints: 60,
        series: [{ name: 'idle', column: 'id' }]
      })
    )
    ing.ingestText(VMSTAT)
    expect(ing.points[0]).toEqual([
      [0, 95],
      [1, 85],
      [2, 91],
      [3, 96]
    ])
  })

  it('honours the rolling window cap', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'static',
        x: 'index',
        maxPoints: 2,
        series: [{ name: 'idle', column: 'id' }]
      })
    )
    ing.ingestText(VMSTAT)
    expect(ing.points[0].map(([, y]) => y)).toEqual([91, 96])
  })

  it('ignores the echoed collection command', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'live',
        x: 'time',
        maxPoints: 60,
        series: [{ name: 'idle', column: 'id' }]
      }),
      { command: 'vmstat 1' }
    )
    expect(ing.ingestLine('vmstat 1')).toBe(false)
    expect(ing.stats.unmatched).toEqual([])
  })

  it('anchors a regex to the Mem: row so Swap: never becomes a point', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'live',
        x: 'index',
        maxPoints: 60,
        series: [{ name: 'used', regex: '^Mem:\\s+\\S+\\s+(\\S+)' }]
      })
    )
    ing.ingestText(FREE)
    expect(ing.points[0].map(([, y]) => y)).toEqual([1512, 1602])
  })

  it('extracts an inline-labelled value by regex', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'live',
        x: 'index',
        maxPoints: 60,
        series: [{ name: 'rtt', regex: 'time=([0-9.]+)' }]
      })
    )
    ing.ingestText(PING)
    expect(ing.points[0].map(([, y]) => y)).toEqual([12.3, 11.8, 13.1])
    // The banner line matched nothing and is kept as a diagnostic sample.
    expect(ing.stats.unmatched).toEqual([PING.split('\n')[0]])
  })

  it('records unmatched lines when the column name never resolves', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'live',
        x: 'time',
        maxPoints: 60,
        series: [{ name: 'usage', column: 'cpu_pct' }]
      })
    )
    ing.ingestText(VMSTAT)
    expect(ing.stats.pointsPlotted).toBe(0)
    expect(ing.stats.linesReceived).toBe(6)
    expect(ing.stats.unmatched.length).toBeGreaterThan(0)
  })

  it('strips ANSI sequences before parsing', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'live',
        x: 'index',
        maxPoints: 60,
        series: [{ name: 'rtt', regex: 'time=([0-9.]+)' }]
      })
    )
    ing.ingestLine('\u001b[32m64 bytes from host: icmp_seq=1 ttl=56 time=9.9 ms\u001b[0m')
    expect(ing.points[0].map(([, y]) => y)).toEqual([9.9])
  })
})

describe('createIngestor — breakdowns', () => {
  it('turns du output into one category per line and drops the grand total', () => {
    const ing = createIngestor(
      spec({
        type: 'pie',
        mode: 'static',
        x: 'path',
        maxPoints: 30,
        series: [{ name: 'size', column: 0, labelColumn: 1 }]
      })
    )
    ing.ingestText(DU)
    const cats = [...ing.cats[0]]
    expect(cats.map(([label]) => label)).toEqual(['./log', './lib', './cache'])
    // Human-readable sizes are normalised to bytes on a 1024 base.
    expect(cats[0][1]).toBe(900 * 1024 ** 2)
    expect(cats[2][1]).toBe(64 * 1024 ** 2)
  })

  it('keeps mount points that contain a path separator via header columns', () => {
    const ing = createIngestor(
      spec({
        type: 'bar',
        mode: 'static',
        x: 'mount',
        maxPoints: 30,
        series: [{ name: 'use%', column: 4, labelColumn: 5 }]
      })
    )
    ing.ingestText(DF)
    expect([...ing.cats[0]]).toEqual([
      ['/', 51],
      ['/dev/shm', 1],
      ['/mnt/data', 65]
    ])
  })

  it('re-inserting a label updates it in place instead of duplicating', () => {
    const ing = createIngestor(
      spec({
        type: 'pie',
        mode: 'static',
        x: 'path',
        maxPoints: 30,
        series: [{ name: 'size', column: 0, labelColumn: 1 }]
      })
    )
    ing.ingestText('10\t./a\n20\t./b\n30\t./a')
    expect([...ing.cats[0]]).toEqual([
      ['./b', 20],
      ['./a', 30]
    ])
  })

  it('falls back to value-then-label when a model regex captures nothing', () => {
    const ing = createIngestor(
      spec({
        type: 'pie',
        mode: 'static',
        x: 'path',
        maxPoints: 30,
        // No capture group at all — the heuristic net has to save this.
        series: [{ name: 'size', regex: '\\S+', labelGroup: 2 }]
      })
    )
    ing.ingestText(DU)
    expect([...ing.cats[0]].map(([label]) => label)).toEqual(['./log', './lib', './cache'])
  })
})

describe('heuristicBreakdown', () => {
  it('takes the first non-negative number as the value and the rest as the label', () => {
    expect(heuristicBreakdown(['3.0M', '/var/log', 'archive'])).toEqual({
      value: 3 * 1024 ** 2,
      label: '/var/log archive'
    })
  })

  it('returns null when nothing follows the number', () => {
    expect(heuristicBreakdown(['head', '-15'])).toBeNull()
  })
})

describe('reset', () => {
  it('clears points, categories and stats', () => {
    const ing = createIngestor(
      spec({
        type: 'line',
        mode: 'live',
        x: 'time',
        maxPoints: 60,
        series: [{ name: 'idle', column: 'id' }]
      })
    )
    ing.ingestText(VMSTAT)
    expect(ing.hasData()).toBe(true)
    ing.reset()
    expect(ing.hasData()).toBe(false)
    expect(ing.stats).toEqual({
      linesReceived: 0,
      headerLines: 0,
      pointsPlotted: 0,
      unmatched: []
    })
    // The resolved column index survives a reset, so a restarted collector
    // plots without waiting for its header to be reprinted — but the cumulative
    // first sample it reprints is still discarded.
    const row = ' 0  0      0 5764404 121980 1899920    0    0     0    16  690 1355  3  1 96  0  0'
    ing.ingestLine(row)
    expect(ing.points[0]).toHaveLength(0)
    ing.ingestLine(row)
    expect(ing.points[0]).toEqual([[expect.any(Number), 96]])
  })
})

describe('parseChartSpec', () => {
  it('treats null extractor fields from structured output as unset', () => {
    const parsed = spec({
      title: null,
      type: 'line',
      mode: 'live',
      x: 'time',
      maxPoints: 60,
      series: [
        { name: 'usage', column: 'id', regex: null, labelGroup: null, labelColumn: null, transform: '100 - x' }
      ]
    })
    expect(parsed.series[0].labelGroup).toBeUndefined()
    expect(parsed.series[0].labelColumn).toBeUndefined()
    // A null labelGroup must not be mistaken for breakdown mode.
    const ing = createIngestor(parsed)
    ing.ingestText(VMSTAT)
    expect(ing.cats[0].size).toBe(0)
    expect(ing.points[0]).toHaveLength(3)
  })

  it('repairs single-backslash regexes that weak models emit', () => {
    const parsed = parseChartSpec('{"type":"line","mode":"live","x":"time","maxPoints":60,"series":[{"name":"v","regex":"\\s+(\\d+)$"}]}')
    expect(parsed.series[0].regex).toBe('\\s+(\\d+)$')
  })

  it('rejects a series with no extractor', () => {
    expect(() =>
      spec({ type: 'line', mode: 'live', x: 'time', maxPoints: 60, series: [{ name: 'usage' }] })
    ).toThrow()
  })

  it('drops a transform that is not a plain arithmetic expression', () => {
    const parsed = spec({
      type: 'line',
      mode: 'live',
      x: 'time',
      maxPoints: 60,
      series: [{ name: 'v', column: 'id', transform: 'fetch(1)' }]
    })
    expect(parsed.series[0].transform).toBeUndefined()
  })
})
