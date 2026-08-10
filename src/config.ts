export const config = {
  /**
   * How long to wait while opening a TCP connection and completing the Bitcoin
   * handshake with a peer. Used for peer discovery/probing and as the connect
   * budget for header and filter downloads. Too low and healthy-but-slow peers
   * look dead; too high and dead peers stall the pipeline before the next attempt.
   */
  peerProbeTimeoutMs: 3_000,
  /**
   * After a peer is live, how long to wait for a getheaders reply while syncing
   * the block header chain. Pair with headerRacePeers: several peers race the
   * same locator, and this is each one’s response budget. Too low causes needless
   * retries; too high leaves you stuck on a peer that never answers.
   */
  headerSyncTimeoutMs: 30_000,
  /**
   * How many peers may race the same header sync request at once. Higher usually
   * finds a responsive peer faster but uses more connections alongside
   * peerConcurrency. Too low slows header sync when some peers are quiet; too
   * high burns sockets and can trip rate limits.
   */
  headerRacePeers: 10,
  /**
   * Cap on peers worked in parallel during discovery/probing. Sets how aggressively
   * the pool is filled before header/filter/block work. Too low underuses the
   * network; too high opens many sockets at once and can overwhelm local resources
   * or remote nodes.
   */
  peerConcurrency: 30,
  /**
   * After handshake, how long to wait for compact-filter traffic (getcfheaders /
   * getcfilters). Batches can be large, so this is usually looser than
   * peerProbeTimeoutMs. Too low fails big batches on slow links; too high delays
   * noticing a stalled filter peer.
   */
  filterSyncTimeoutMs: 120_000,
  /**
   * How many filter-download sessions may run at once. With the batch sizes below,
   * this is the main knob for filter-sync throughput. Too low stretches the scan;
   * too high multiplies bandwidth and peer load.
   */
  filterConcurrency: 30,
  /**
   * How many compact-filter headers to ask for per request. Larger batches mean
   * fewer round trips but heavier replies and more pain if a peer dies mid-batch
   * (see filterSyncTimeoutMs). Too small chatters; too large risks timeouts and
   * wasted work on failure.
   */
  filterHeaderBatchSize: 2000,
  /**
   * How many compact filters to fetch per request once filter headers are in hand.
   * Same tradeoff as filter-header batches: throughput vs. timeout risk and retry
   * cost. Too small is chatty; too large is slow to fail and expensive to redo.
   */
  filterBatchSize: 1000,
  /**
   * Connect + handshake budget for a peer used only to download blocks (separate
   * from general peerProbeTimeoutMs). Too low drops usable peers early; too high
   * leaves slots occupied by peers that never come up.
   */
  blockConnectTimeoutMs: 3_000,
  /**
   * After handshake, how long to wait for the block after getdata. Full blocks are
   * larger than headers/filters, so this is often longer than probe timeouts. Too
   * low fails on slow peers; too high stalls a download slot on a silent peer.
   */
  blockSyncTimeoutMs: 30_000,
  /**
   * How many one-shot block downloads may run at once. Main throughput knob once
   * matching has flagged blocks of interest. Too low stretches catch-up; too high
   * spikes bandwidth and open sessions.
   */
  blockConcurrency: 30,
  /**
   * BIP44-style unused-address lookaround. When a used index falls in the last
   * gapLimit of the watch window, grow that chain by gapLimit and rematch.
   * Too low may miss sparse address use; too high derives/matches more scripts.
   */
  gapLimit: 100,
  /**
   * How many addresses to derive per chain (receive / change) before any growth.
   * Sized so typical wallets finish in one match pass; growth still uses gapLimit.
   */
  initialWatchCount: 100,
};
