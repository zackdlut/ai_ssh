import { describe, expect, it } from 'vitest'
import { matchChartTemplate } from './chartTemplates'
import { createIngestor } from './chartIngest'

const VMSTAT = `procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 2  0      0 5765160 121980 1899888    0    0    18    23  102  210  4  1 95  0  0
 1  0      0 5764656 121980 1899888    0    0     0     0  843 1620 12  3 85  0  0
 0  0      0 5764404 121980 1899888    0    0     0     0  711 1402  7  2 91  0  0`

describe('matchChartTemplate — vmstat', () => {
  it('maps a CPU usage request to the complement of the idle column', () => {
    const m = matchChartTemplate('实时折线图：CPU 使用率，数据来自 vmstat 1', 'vmstat 1')
    expect(m?.id).toBe('vmstat.cpu-usage')
    expect(m?.spec.series[0]).toMatchObject({ column: 'id', transform: '100 - x' })
    expect(m?.spec.mode).toBe('live')
    expect(m?.spec.x).toBe('time')
  })

  it('maps an idle request to the raw idle column', () => {
    expect(matchChartTemplate('CPU 空闲率折线图', 'vmstat 1')?.id).toBe('vmstat.cpu-idle')
    expect(matchChartTemplate('plot cpu idle over time', 'vmstat 1')?.id).toBe('vmstat.cpu-idle')
  })

  it('maps a memory request to the free column', () => {
    const m = matchChartTemplate('内存空闲量实时折线图', 'vmstat 1')
    expect(m?.id).toBe('vmstat.memory-free')
    expect(m?.spec.series[0]).toMatchObject({ column: 'free' })
  })

  it('declines a one-shot vmstat with no interval', () => {
    expect(matchChartTemplate('CPU 使用率', 'vmstat')).toBeNull()
  })

  it('produces a spec that actually extracts the intended values', () => {
    const m = matchChartTemplate('把 CPU 使用率画成实时折线图', 'vmstat 1')!
    const ing = createIngestor(m.spec, { command: 'vmstat 1' })
    ing.ingestText(VMSTAT)
    // First sample dropped as cumulative; 100 - 85 and 100 - 91 remain.
    expect(ing.points[0].map(([, y]) => y)).toEqual([15, 9])
  })
})

describe('matchChartTemplate — free', () => {
  it('anchors used memory to the Mem: row', () => {
    const m = matchChartTemplate('内存使用量实时折线图', 'free -m -s 1')
    expect(m?.id).toBe('free.used')
    const ing = createIngestor(m!.spec)
    ing.ingestText(
      `               total        used        free      shared  buff/cache   available
Mem:            7847        1512        4210         168        2124        5904
Swap:           2047           0        2047`
    )
    expect(ing.points[0].map(([, y]) => y)).toEqual([1512])
  })

  it('picks the available column when the description asks for it', () => {
    const m = matchChartTemplate('可用内存曲线', 'free -m -s 1')
    expect(m?.id).toBe('free.available')
    const ing = createIngestor(m!.spec)
    ing.ingestText('Mem:            7847        1512        4210         168        2124        5904')
    expect(ing.points[0].map(([, y]) => y)).toEqual([5904])
  })

  it('declines a one-shot free with no -s interval', () => {
    expect(matchChartTemplate('内存', 'free -m')).toBeNull()
  })
})

describe('matchChartTemplate — ping / iostat', () => {
  it('extracts round-trip time from ping output', () => {
    const m = matchChartTemplate('把延迟画成实时折线图', 'ping example.com')
    expect(m?.id).toBe('ping.latency')
    const ing = createIngestor(m!.spec)
    ing.ingestText('64 bytes from 1.1.1.1: icmp_seq=1 ttl=56 time=12.3 ms')
    expect(ing.points[0].map(([, y]) => y)).toEqual([12.3])
  })

  it('maps iostat to the %util column', () => {
    const m = matchChartTemplate('磁盘 IO 实时图', 'iostat -x 1')
    expect(m?.id).toBe('iostat.util')
    const ing = createIngestor(m!.spec)
    ing.ingestText(
      `Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s  %util
sda              1.20     48.00     0.10   7.69    0.42    40.00    3.40   2.50
sda              0.90     12.00     0.00   0.00    0.31    13.33    1.10   0.80
sda              1.05     20.00     0.05   4.55    0.36    19.05    2.20   1.40`
    )
    // iostat's first sample is a since-boot average, so it is discarded.
    expect(ing.points[0].map(([, y]) => y)).toEqual([0.8, 1.4])
  })
})

describe('matchChartTemplate — breakdowns', () => {
  it('builds a static du breakdown and honours a pie request', () => {
    expect(matchChartTemplate('磁盘占用柱状图', 'du -h --max-depth=1 /var')?.spec.type).toBe('bar')
    const pie = matchChartTemplate('磁盘占用饼图', 'du -h --max-depth=1 /var')
    expect(pie?.spec.type).toBe('pie')
    expect(pie?.spec.mode).toBe('static')

    const ing = createIngestor(pie!.spec)
    ing.ingestText('1.4G\t.\n900M\t./log\n420M\t./lib')
    expect([...ing.cats[0]].map(([label]) => label)).toEqual(['./log', './lib'])
  })

  it('reads the use% and mount columns from df -h', () => {
    const m = matchChartTemplate('各挂载点磁盘使用率', 'df -h')
    expect(m?.id).toBe('df.usage')
    const ing = createIngestor(m!.spec)
    ing.ingestText(
      `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       457G  221G  213G  51% /
/dev/sdb1       1.8T  1.1T  620G  65% /mnt/data`
    )
    expect([...ing.cats[0]]).toEqual([
      ['/', 51],
      ['/mnt/data', 65]
    ])
  })
})

describe('matchChartTemplate — misses', () => {
  it('returns null without a command', () => {
    expect(matchChartTemplate('CPU 使用率折线图', undefined)).toBeNull()
    expect(matchChartTemplate('CPU 使用率折线图', '   ')).toBeNull()
  })

  it('returns null for a command it does not know', () => {
    expect(matchChartTemplate('画个图', 'sar -u 1')).toBeNull()
    expect(matchChartTemplate('画个图', 'cat /proc/stat')).toBeNull()
  })

  it('looks through a sudo prefix', () => {
    expect(matchChartTemplate('CPU 使用率', 'sudo vmstat 1')?.id).toBe('vmstat.cpu-usage')
  })

  it('matches on the first stage of a pipeline', () => {
    expect(matchChartTemplate('磁盘占用', 'du -h --max-depth=1 / | sort -rh | head -15')?.id).toBe(
      'du.breakdown'
    )
  })
})
