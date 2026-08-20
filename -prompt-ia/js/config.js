/**
 * App config — the n8n webhook base URL is the ONLY backend this tool talks to.
 *
 * This URL is public (not a secret). All membership verification, feedback and
 * data-deletion run server-side inside n8n, which holds every backend
 * credential. No database URL, key, or table name ever reaches the browser —
 * the tool ships zero backend infrastructure information.
 */
window.APP_CONFIG = {
  n8nWebhookBase: 'https://admin.appsbrasil.store/api'
};
