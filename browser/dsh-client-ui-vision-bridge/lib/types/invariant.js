/**
 * Invariant note for the ui-vision-bridge package.
 *
 * The browser half patches the global `fetch` for the lifetime of the plugin
 * and must restore it on dispose (HMR reload). It only rewrites outgoing
 * `session.prompt` requests that carry image parts; every other request is
 * passed through untouched. No server-side behavior is introduced, so a
 * deployment that never mounts the browser half loses nothing.
 */
export {};
//# sourceMappingURL=invariant.js.map