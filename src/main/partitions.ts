/** Normal browsing: cookies and storage persist across restarts. */
export const PARTITION = 'persist:default'

/**
 * Amnesia tabs: a non-persistent partition, so cookies and storage vanish when
 * the tab closes. Nothing from these tabs is written to the history database.
 */
export const AMNESIA_PARTITION = 'amnesia'

export const ALL_PARTITIONS = [PARTITION, AMNESIA_PARTITION]
