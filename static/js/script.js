document.addEventListener("DOMContentLoaded", function () {
  const form = document.getElementById("searchbar");
  const spinner = document.getElementById("loading-spinner");
  const svg = document.getElementById("visualization");
  const stopButton = document.getElementById("stopButton");

  // Track the current stream's ID and an AbortController
  let activeStreamId = null;
  let controller = null;

  // Attach event listeners
  if (form) {
    form.addEventListener("submit", onFormSubmit);
  }
  if (stopButton) {
    stopButton.addEventListener("click", onStopClick);
  }

  /**
   * Open a graph straight from the URL: /?term=gradient%20descent
   *
   * Lets another page hand SemAtlas a topic instead of asking the reader to
   * retype it, which is how learn.sematlas.com links here from a slide.
   * Optional &source=wikipedia and &depth=1..3 mirror the form controls;
   * anything missing leaves the form as it already is.
   */
  function runFromUrl() {
    const p = new URLSearchParams(window.location.search);
    const term = (p.get("term") || p.get("q") || "").trim();
    if (!term || !form) return;

    const box = document.getElementById("searchBox");
    if (!box) return;
    box.value = term;

    const source = p.get("source");
    if (source) {
      const radio = document.getElementById(source.toLowerCase());
      if (radio) radio.checked = true;
    }
    const depth = p.get("depth");
    if (depth) {
      const d = document.getElementById("depth" + depth);
      if (d) d.checked = true;
    }

    // go through the form's own handler, so streaming and the stop button
    // behave exactly as they do for a typed search
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }

  runFromUrl();

  /**
   * Theme toggle. The graph reads its colours at draw time, so switching only
   * needs the attribute flipped and the current graph redrawn.
   */
  const themeToggle = document.getElementById("themeToggle");
  function labelTheme() {
    if (!themeToggle) return;
    const dark = document.documentElement.getAttribute("data-theme") !== "light";
    themeToggle.textContent = dark ? "Light mode" : "Dark mode";
  }
  labelTheme();
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      const next = document.documentElement.getAttribute("data-theme") === "light"
        ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("sa-theme", next); } catch (e) {}
      labelTheme();
      if (typeof rethemeGraph === "function") rethemeGraph();
    });
  }

  /**
   * Handler for form submission (new search).
   * 1) If there is an active stream, stop it first.
   * 2) Then start the new search request.
   */
  async function onFormSubmit(e) {
    e.preventDefault();

    // Stop any existing stream before starting a new one
    if (activeStreamId) {
      await stopCurrentStream();
    }

    spinner.style.display = "flex";
    const formData = new FormData(form);
    shrinkSearchBox();

    // Create a new AbortController for the upcoming fetch
    controller = new AbortController();

    try {
      const response = await fetch("/visualize", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      // Show the Stop button when we begin streaming
      stopButton.style.display = "inline-block";

      const reader = response.body.getReader();
      let done = false;
      let incompleteChunk = "";

      // Initialize or reset your visualization graph
      setUpGraph();

      while (!done) {
        const { value, done: isDone } = await reader.read();
        if (!value) {
          done = isDone;
          continue;
        }

        const text = new TextDecoder().decode(value).trim();
        const chunks = text.split("\n\n"); // each SSE data chunk ends with "\n\n"

        for (const chunk of chunks) {
          if (!chunk) continue;
          let data;
          let parsed = true;
          try {
            data = JSON.parse(incompleteChunk + chunk);
          } catch (error) {
            parsed = false;
            console.warn("JSON parse error (likely incomplete chunk):", error.message);
          }

          if (parsed) {
            if (data.stream_id) {
              // The special first chunk with the stream ID
              activeStreamId = data.stream_id;
              console.log("Received stream_id:", activeStreamId);
            } else {
              // Log debug info if present
              if (data._debug) {
                console.log("🔍 [" + data._debug.step + "] " + data._debug.message, data._debug);
              }

              // Subsequent data for your visualization
              console.log("Rendering graph with data:", {
                nodes: data.nodes ? data.nodes.length : 0,
                links: data.links ? data.links.length : 0,
                sample_node: data.nodes ? data.nodes[0] : null
              });

              if (!data.nodes || !Array.isArray(data.nodes)) {
                console.error("❌ Invalid data format: missing or invalid nodes array", data);
              } else if (!data.links || !Array.isArray(data.links)) {
                console.error("❌ Invalid data format: missing or invalid links array", data);
              } else {
                visualized3(data);
              }
            }
            incompleteChunk = "";
          } else {
            // Keep appending data if JSON was split
            incompleteChunk += chunk;
          }
        }

        done = isDone;
        spinner.classList.add("bottom");
      }
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Fetch aborted (either by Stop or a new search).");
      } else {
        console.error(error);
        alert("There was an error processing your request.");
      }
    } finally {
      spinner.classList.remove("bottom");
      spinner.style.display = "none";

      // Hide the Stop button once the stream finishes or is aborted
      stopButton.style.display = "none";

      // Reset the active stream references
      activeStreamId = null;
      controller = null;
    }
  }

  /**
   * Click handler for the manual "Stop" button.
   * Immediately stops the current stream if there is one.
   */
  async function onStopClick() {
    if (!activeStreamId) return;
    await stopCurrentStream();
  }

  /**
   * Stops the current stream on both server and client.
   * Sends a POST to /stop/<stream_id> and then aborts the fetch.
   */
  async function stopCurrentStream() {
    if (!activeStreamId) return;

    try {
      // Signal the server to stop the process
      await fetch(`/stop/${activeStreamId}`, {
        method: "POST",
      });

      // Abort the ongoing fetch (client side)
      if (controller) {
        controller.abort();
      }
    } catch (err) {
      console.error("Error stopping the stream:", err);
    } finally {
      // Clean up references and hide the stop button
      activeStreamId = null;
      controller = null;
      stopButton.style.display = "none";
    }
  }

  // Toggle Graph Controls Panel
  const toggleButton = document.getElementById("toggle-graph-controls");
  const graphControls = document.getElementById("graph-controls");
  
  if (toggleButton && graphControls) {
    toggleButton.addEventListener("click", function () {
      if (graphControls.style.display === "none" || graphControls.style.display === "") {
        graphControls.style.display = "block";
        toggleButton.textContent = "Hide Options";
        toggleButton.style.backgroundColor = "#1976D2";
      } else {
        graphControls.style.display = "none";
        toggleButton.textContent = "Customize Graph";
        toggleButton.style.backgroundColor = "#2196F3";
      }
    });
  }
});


function shrinkSearchBox() {
  const searchBox = document.getElementById("mySidebar");
  if (!searchBox) return;

  searchBox.style.top = "1%";
  searchBox.style.left = "1%";
  searchBox.style.transform = "translate(0%, 0%)";
  searchBox.classList.add("shrunken");

  const children = searchBox.children;
  for (let i = 0; i < children.length; i++) {
    children[i].style.display = "none";
  }

  const searchLink = document.createElement("a");
  searchLink.href = "javascript:void(0)";
  searchLink.innerText = "Search";
  searchLink.style.top = "50%";
  searchLink.style.left = "50%";
  searchLink.style.transform = "translate(-50%, -50%)";
  searchLink.className = "search-link";
  searchLink.style.position = "absolute";
  searchLink.onclick = expandSearchBox;
  searchBox.appendChild(searchLink);
}


function expandSearchBox() {
  const searchBox = document.getElementById("mySidebar");
  if (!searchBox) return;

  searchBox.classList.remove("shrunken");
  const searchLink = document.querySelector("a.search-link");
  if (searchLink) {
    searchBox.removeChild(searchLink);
  }
  const children = searchBox.children;
  for (let i = 0; i < children.length; i++) {
    children[i].style.display = "";
  }
}
