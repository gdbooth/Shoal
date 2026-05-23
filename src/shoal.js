window.addEventListener("error", function (e) {
    var el = document.getElementById("error-overlay");
    el.style.display = "block";
    el.textContent =
        "Runtime error:\n" +
        e.message +
        "\n\nFile: " +
        e.filename +
        ":" +
        e.lineno +
        "\n\nStack:\n" +
        ((e.error && e.error.stack) || "(no stack)");
});

window.addEventListener("unhandledrejection", function (e) {
    var el = document.getElementById("error-overlay");
    el.style.display = "block";
    el.textContent =
        "Unhandled promise rejection:\n" +
        ((e.reason && e.reason.message) || e.reason || "unknown");
});