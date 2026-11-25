// Imported first by tests that read WARN lines: the logger reads its level once,
// when it loads, and defaults to ERROR. Prod sets HYDRADB_LOG_LEVEL=INFO.
process.env.HYDRADB_LOG_LEVEL = "INFO";
