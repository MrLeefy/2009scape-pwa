/*! coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
let coepCredentialless = true;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (ev.data && ev.data.type === "deregister") {
            self.registration.unregister().then(() => {
                return self.clients.matchAll();
            }).then(clients => {
                clients.forEach((client) => client.navigate(client.url));
            });
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, { credentials: "omit" })
            : r;
        
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    if (!coepCredentialless) {
                        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });
} else {
    (() => {
        const reloadedByCOI = window.sessionStorage.getItem("coiReloadedByCOI");
        window.sessionStorage.removeItem("coiReloadedByCOI");

        const coiCheck = () => {
            const coiSupported = window.crossOriginIsolated !== false;
            if (coiSupported) {
                return;
            }

            if (reloadedByCOI) {
                console.log("coi-serviceworker: cross-origin isolation via SW failed.");
                return;
            }

            if (window.isSecureContext) {
                navigator.serviceWorker
                    .register(window.document.currentScript.src)
                    .then(
                        (registration) => {
                            console.log("coi-serviceworker: registered, reloading page...");
                            window.sessionStorage.setItem("coiReloadedByCOI", "true");
                            registration.addEventListener("updatefound", () => {
                                registration.installing.addEventListener("statechange", function () {
                                    if (this.state === "activated") {
                                        window.location.reload();
                                    }
                                });
                            });
                            if (registration.active && !navigator.serviceWorker.controller) {
                                window.location.reload();
                            }
                        },
                        (err) => {
                            console.error("coi-serviceworker: registration failed:", err);
                        }
                    );
            } else {
                console.log("coi-serviceworker: requires secure context (HTTPS or localhost)");
            }
        };

        // Use credentialless where supported
        if (window.crossOriginIsolated === false) {
            coepCredentialless = true;
        }

        coiCheck();
    })();
}
