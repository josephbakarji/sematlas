let existingNodes = new Map();  // Maps node names to their positions
const padding = 20;
const text_padding = 5;

const NBODY_CHARGE = -1600;
const LINK_DISTANCE = 190;
const LINK_STRENGTH = 0.4;
let COLLISON_PADDING = 3;  // Changed to let since we'll modify it
const sim_alpha = 0.2;
const ZOOM_SEARCH_DURATION = 500;

const MAIN_ARTICLE_FONT_SIZE = 42;
const LEVEL_1_FONT_SIZE = 30;
const FONT_SIZE = 20;
const FONT_ARRAY = [42, 30, 20];
const FSIZE_FACTOR = 1.0;

const LINK_WIDTH = 5;
const LINK_OPACITY = 0.2;
const REC_FILLET = 5;
const BACKGROUND_COLOR = "#f5f5f5";

/**
 * Theme palette.
 *
 * These are read at *draw* time, never at load time. graph.js is included in
 * <head> before the stylesheet, so anything that asks the document for a
 * computed CSS variable while this file is being parsed gets an empty string
 * and silently falls back. That is what left the links and the root node black
 * on the dark theme.
 */
const THEMES = {
  dark: {
    link: "#7f93ad",
    linkOpacity: 0.55,
    nodeStroke: "#48607f",
    rootFill: "#ffffff",
    rootText: "#12161d",
    nodeText: "#12161d",
    highlightStroke: "#dce4ef",
  },
  light: {
    link: "black",
    linkOpacity: 0.35,
    nodeStroke: null,
    rootFill: "#000000",
    rootText: "#ffffff",
    nodeText: "#000000",
    highlightStroke: "#000000",
  },
};

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light" : "dark";
}
function pal() {
  return THEMES[currentTheme()];
}
const INCLUDE_LINKS = true;

const DEFAULT_CHARGE = -1200;
const DEFAULT_LINK_DISTANCE = 140;
const DEFAULT_COLLISION = 3;


const DESATURATION_FACTOR = 0.7;

// Highlight colors for relevance scores (golden/yellow for more relevance)

const TOOLTIP_STYLES = {
    BACKGROUND: "rgba(0, 0, 0, 0.8)",
    TEXT_COLOR: "white",
    PADDING: "10px",
    BORDER_RADIUS: "4px",
    MAX_WIDTH: "300px",
    FONT_SIZE: "14px",
    TRANSITION: "opacity 0.2s",
    Z_INDEX: "1000"
};

const meta = {};

function metaFor(node) {
  if (!node || !node.name) return { width: 0, height: 0 };
  return meta[node.name] || { width: 0, height: 0 };
}

const simulation = d3
  .forceSimulation()
  .force("x", d3.forceX().strength(0.05))
  .force("y", d3.forceY().strength(0.05))
  .force("collide", forceCollide())
  .force(
    "link",
    d3.forceLink().id((d) => d.name).distance(DEFAULT_LINK_DISTANCE)
  )
  .force("charge", d3.forceManyBody().strength(DEFAULT_CHARGE));

const zoom = d3
  .zoom()
  .scaleExtent([0.05, 3])
  .on("start", function (event) {
    d3.select("#visualization").style("cursor", "grabbing");
  })
  .on("end", function (event) {
    d3.select("#visualization").style("cursor", "default");
  })
  .on("zoom", zoomed);

function zoomed({ transform }) {
  d3.select("#viz_content").attr("transform", transform);
}

// This function reverts all node colors and filters to the original loaded graph colors.


function createForceSliders() {
  // Select only the slider controls container (leaving the header intact)
  const container = d3.select("#slider-controls");
  
  // Clear any previous slider controls
  container.selectAll("*").remove();
  
  // Node Repulsion slider
  const repulsionGroup = container.append("div")
    .attr("class", "force-slider-group")
    .style("margin-bottom", "15px");
  
  repulsionGroup.append("div")
    .attr("class", "force-slider-label")
    .style("margin-bottom", "5px")
    .html("Node Repulsion: <span class='force-slider-value'>" + DEFAULT_CHARGE + "</span>");
  
  repulsionGroup.append("input")
    .attr("type", "range")
    .attr("class", "force-slider")
    .style("width", "100%")
    .attr("min", -2000)
    .attr("max", -200)
    .attr("value", DEFAULT_CHARGE)
    .on("input", function() {
      const value = +this.value;
      repulsionGroup.select(".force-slider-value").text(value);
      simulation.force("charge").strength(value);
      simulation.alpha(0.3).restart();
    });
  
  // Link Distance slider
  const linkDistanceGroup = container.append("div")
    .attr("class", "force-slider-group")
    .style("margin-bottom", "15px");
  
  linkDistanceGroup.append("div")
    .attr("class", "force-slider-label")
    .style("margin-bottom", "5px")
    .html("Link Distance: <span class='force-slider-value'>" + DEFAULT_LINK_DISTANCE + "</span>");
  
  linkDistanceGroup.append("input")
    .attr("type", "range")
    .attr("class", "force-slider")
    .style("width", "100%")
    .attr("min", 50)
    .attr("max", 300)
    .attr("value", DEFAULT_LINK_DISTANCE)
    .on("input", function() {
      const value = +this.value;
      linkDistanceGroup.select(".force-slider-value").text(value);
      simulation.force("link").distance(value);
      simulation.alpha(0.3).restart();
    });
}

function setUpGraph() {
  let width = window.innerWidth;
  let height = window.innerHeight;

  color = d3.scaleOrdinal(d3.range(10), d3.schemeTableau10);

  const svg = d3.select("#visualization");

  // Create tooltip div if it doesn't exist
  if (d3.select("body").select(".graph-tooltip").empty()) {
    d3.select("body")
      .append("div")
      .attr("class", "graph-tooltip")
      .style("position", "absolute")
      .style("opacity", 0)
      .style("background-color", TOOLTIP_STYLES.BACKGROUND)
      .style("color", TOOLTIP_STYLES.TEXT_COLOR)
      .style("padding", TOOLTIP_STYLES.PADDING)
      .style("border-radius", TOOLTIP_STYLES.BORDER_RADIUS)
      .style("max-width", TOOLTIP_STYLES.MAX_WIDTH)
      .style("font-size", TOOLTIP_STYLES.FONT_SIZE)
      .style("pointer-events", "none")
      .style("z-index", TOOLTIP_STYLES.Z_INDEX)
      .style("transition", TOOLTIP_STYLES.TRANSITION);
  }

  svg
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("style", "max-width: 100%; height: auto;")
    .call(zoom);

  svg.on("dblclick.zoom", null);

  let g = svg.append("g").attr("id", "viz_content");
  g.append("g").attr("class", "link-container");
  g.append("g").attr("class", "node-container");
}

function visualized3(data) {
  let width = window.innerWidth;
  let height = window.innerHeight;

  const center_grav_strength_x = 0.05;
  const center_grav_strength_y =
    ((center_grav_strength_x * width) / height) * 1.5;

  const svg = d3.select("#visualization");

  // Create UI elements
  createForceSliders();

  // Build set of valid node names for link validation
  const validNodeNames = new Set(data.nodes.map(n => n.name));

  // Filter links to only include those where both source and target nodes exist
  const links = data.links.filter(link => {
    const sourceName = typeof link.source === 'string' ? link.source : link.source.name;
    const targetName = typeof link.target === 'string' ? link.target : link.target.name;
    const valid = validNodeNames.has(sourceName) && validNodeNames.has(targetName);
    if (!valid) {
      console.warn(`Filtering invalid link: ${sourceName} -> ${targetName}`);
    }
    return valid;
  });

  d3.select(".more-options-container").style("display", "block");
  d3.selectAll(".node-container g").each(function(d) {
    if (d && existingNodes.has(d.name)) {
      // Check if d.x and d.y are numbers and not NaN
      const validX = !isNaN(d.x);
      const validY = !isNaN(d.y);
  
      if (validX && validY) {
        // Update only if both x and y are valid
        existingNodes.set(d.name, { x: d.x, y: d.y });
      } else {
        // If either x or y is NaN, use the existing valid positions from existingNodes
        const existingNode = existingNodes.get(d.name);
        existingNodes.set(d.name, {
          x: validX ? d.x : existingNode.x,
          y: validY ? d.y : existingNode.y
        });
      }
    }
  });


  // Function to find position for a new node by looking up connected nodes by name
  function findConnectedNodePosition(node, nodesArray) {
    // Helper to get node name (handles both string refs and object refs)
    const getName = (ref) => (typeof ref === 'string' ? ref : ref.name);

    const connectedLink = data.links.find(link => {
      const sourceName = getName(link.source);
      const targetName = getName(link.target);

      return (targetName === node.name && existingNodes.has(sourceName)) ||
             (sourceName === node.name && existingNodes.has(targetName));
    });

    if (connectedLink) {
      const sourceName = getName(connectedLink.source);
      const targetName = getName(connectedLink.target);
      // Return the position of the connected node that already exists
      const connectedNodeName = targetName === node.name ? sourceName : targetName;
      const parentPos = existingNodes.get(connectedNodeName);
      if (parentPos) {
        // Add small random offset so nodes don't stack exactly
        return {
          x: parentPos.x + (Math.random() - 0.5) * 50,
          y: parentPos.y + (Math.random() - 0.5) * 50
        };
      }
    }
    return null;
  }
  
  // Create or update nodes with preserved positions for existing nodes
  const nodes = data.nodes.map(d => {
    if (existingNodes.has(d.name)) {
      // Existing node: use stored position
      return { ...d, ...existingNodes.get(d.name) };
    } else {
      // New node: position near a connected node or randomly
      const connectedNodePosition = findConnectedNodePosition(d, data.nodes);
      const newNode = {
        ...d,
        x: connectedNodePosition ? connectedNodePosition.x : Math.random() * width,
        y: connectedNodePosition ? connectedNodePosition.y : Math.random() * height
      };
      return newNode;
    }
  });
  

  // Update the existingNodes map
  nodes.forEach(node => {
    existingNodes.set(node.name, { x: node.x, y: node.y })
  });


  // Store graph data for interactions
  currentGraphData = { nodes, links };

  // Get links from link-container
  let linkGroup = svg.select(".link-container");

  // Define links - key handles both string refs (backend) and object refs (after D3)
  const link = linkGroup
    .selectAll("line")
    .data(links, (d) => `${d.source.name || d.source}-${d.target.name || d.target}`)
    .join("line")
    .attr("stroke-width", LINK_WIDTH)
    .attr("stroke", pal().link)
    .attr("stroke-opacity", pal().linkOpacity);

  // Get nodes from node-container
  let nodeGroup = svg.select(".node-container");

  // Define nodes
  const node = nodeGroup
    .selectAll("g")
    .data(nodes, (d) => d.name)
    .join((enter) => {
      const single = enter.append("g")
        .attr("class", "node-group");
      const hyperlink = single
        .append("a")
        .attr("href", (d) => d.url)
        .attr("target", "_blank");

      hyperlink.on("dblclick", (event, d) => {
        window.open(d.url, "_blank");
      });

      hyperlink.on("click", (event) => {
        event.preventDefault();
      });

      const rect = hyperlink
        .append("rect")
        .attr("rx", REC_FILLET)
        .attr("fill", (d) => {
          // Set root node color to black, store original color for others
          if (d.level === 0) {
            d.originalColor = pal().rootFill;
            return pal().rootFill;
          }
          d.originalColor = d.color;
          return d.color;
        })
        .attr("stroke", (d) => {
          let origStroke = d.level >= 3 ? color(d.group) : pal().nodeStroke;
          d.originalStroke = origStroke; // Store original stroke
          return origStroke;
        })
        .attr("stroke-width", 3)
        .attr("width", 20) // Temporary
        .attr("height", 20); // Temporary

      const text = hyperlink
        .append("text")
        .text((d) => d.name)
        // node fills are light in both themes, so the label is dark in both
        .attr("fill", pal().nodeText)
        .attr("class", "text-item");

      text.each(function (d) {
        if (d.level === 0) {
          d3.select(this)
            .attr("font-weight", "bold")
            // was hardcoded white, from when the root node was black. With a
            // white root that left white text on white until you toggled the
            // theme and the recolour pass fixed it.
            .attr("fill", pal().rootText)
            .attr("font-size", MAIN_ARTICLE_FONT_SIZE);
        } else if (d.level === 1) {
          d3.select(this).attr("font-size", LEVEL_1_FONT_SIZE);
        }
      });

      return single;
    });

  nodeGroup.selectAll(".text-item").each(function (d) {
    const bbox = this.getBBox();
    meta[d.name] = {
      width: bbox.width,
      height: bbox.height,
    };
    d.width = 1;
    d3.select(this.previousSibling)
      .attr("x", bbox.x - text_padding)
      .attr("y", bbox.y - text_padding)
      .attr("width", bbox.width + 2 * text_padding)
      .attr("height", bbox.height + 2 * text_padding);
  });

  simulation
    .nodes(nodes)
    .force("x", d3.forceX(width / 2).strength(center_grav_strength_x))
    .force("y", d3.forceY(height / 2).strength(center_grav_strength_y));

  if (INCLUDE_LINKS) {
    simulation.force(
      "link",
      d3
        .forceLink(links)
        .id((d) => d.name)
        .distance(LINK_DISTANCE)
        .strength(LINK_STRENGTH)
    );
  }

  simulation.alpha(sim_alpha).restart();

  let counter = 0;

  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr(
        "y1",
        (d) =>
          d.source.y -
          (metaFor(d.source).height
            ? (metaFor(d.source).height + text_padding) / 2
            : 0)
      )
      .attr("x2", (d) => d.target.x)
      .attr(
        "y2",
        (d) =>
          d.target.y -
          (metaFor(d.target).height
            ? (metaFor(d.target).height + text_padding) / 2
            : 0)
      );

    node.attr("transform", (d) => {
      return `translate(${d.x - metaFor(d).width / 2},${
        d.y - metaFor(d).height / 2
      })`;
    });
  });

  // Set root node to center
  nodes.forEach((node) => {
    if (node.level === 0) {
      node.fx = width / 2;
      node.fy = height / 2;
    }
  });

  function fitGraphToView() {
    let xExtent = d3.extent(nodes, (d) => d.x);
    let yExtent = d3.extent(nodes, (d) => d.y);

    let bboxWidth = xExtent[1] - xExtent[0];
    let bboxHeight = yExtent[1] - yExtent[0];
    let scaleX = width / bboxWidth;
    let scaleY = height / bboxHeight;
    let scale = Math.min(0.9, Math.min(scaleX, scaleY)); // Adding a maximum limit to the scale for safety

    let centerX = (xExtent[1] + xExtent[0]) / 2;
    let centerY = (yExtent[1] + yExtent[0]) / 2;
    let translateX = width / 2 - centerX * scale;
    let translateY = height / 2 - centerY * scale;

    svg
      .transition()
      .duration(ZOOM_SEARCH_DURATION)
      .call(
        zoom.transform,
        d3.zoomIdentity.translate(translateX, translateY).scale(scale)
      );
  }

  // Call this function after the graph has been generated
  setTimeout(fitGraphToView, 200);

  if (window.onGraphDrawn) window.onGraphDrawn();

  // Click and Dragging Behavior
  const drag = d3.drag().on("start", dragstart).on("drag", dragged);

  node.call(drag).on("click", click).on("contextmenu", (event, d) => {
    showContextMenu(event, d);
  });

  function dragstart() {
    d3.select(this).raise();
    d3.select(this).classed("fixed", true);
  }

  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
    simulation.alpha(0.5).restart();
  }

  function click(event, d) {
    if (d3.select(this).classed("fixed")) {
      delete d.fx;
      delete d.fy;
      d3.select(this).classed("fixed", false);
    }
  }
}

////////////////////////////////////////////////////
let count = 0;
function forceCollide() {
  let nodes;

  function force(alpha) {
    const quad = d3.quadtree(
      nodes,
      (d) => d.x,
      (d) => d.y
    );
    for (const d of nodes) {
      quad.visit((q, x1, y1, x2, y2) => {
        let updated = false;
        if (q.data && q.data !== d) {
          let x = d.x - q.data.x,
            y = d.y - q.data.y,
            xSpacing = padding + (metaFor(q.data).width + metaFor(d).width) / 2,
            ySpacing =
              padding + (metaFor(q.data).height + metaFor(d).height) / 2,
            absX = Math.abs(x),
            absY = Math.abs(y),
            l,
            lx,
            ly;

          if (absX < xSpacing && absY < ySpacing) {
            l = Math.sqrt(x * x + y * y) + COLLISON_PADDING;

            lx = (absX - xSpacing) / l;
            ly = (absY - ySpacing) / l;

            // the one that's barely within the bounds probably triggered the collision
            if (Math.abs(lx) > Math.abs(ly)) {
              lx = 0;
            } else {
              ly = 0;
            }
            d.x -= x *= lx;
            d.y -= y *= ly;
            q.data.x += x;
            q.data.y += y;

            updated = true;
          }
        }
        return updated;
      });
    }
  }

  force.initialize = (_) => (nodes = _);

  return force;
}

// Used for debugging. not used now
function updateNodeSize(newFontSize) {
  const svg = d3.select("#visualization");
  const nodes = svg.selectAll(".node-container");

  nodes.selectAll("text").attr("font-size", newFontSize);

  nodes.selectAll("text").each(function (d) {
    const bbox = this.getBBox();
    d.bbox = bbox;
    d.width = bbox.width;
    d.height = bbox.height;
    d3.select(this.previousSibling)
      .attr("x", bbox.x - text_padding)
      .attr("y", bbox.y - text_padding)
      .attr("width", bbox.width + 2 * text_padding)
      .attr("height", bbox.height + 2 * text_padding);
  });
  // Any other elements or attributes that depend on node size should be updated here as well
}

let activeStreamId = null;

// Global state for node interactions
let selectedNode = null;
let contextMenuNode = null;
let currentGraphData = null;

// highlight_nodes and its helpers were removed with the prompt panel: scoring
// nodes against a phrase and recolouring them never answered a question. Its
// replacement lives in ask.js: an answer drawn from the node abstracts, with
// the nodes it used marked.

// Context menu functions
function showContextMenu(event, node) {
  event.preventDefault();
  hideContextMenu();

  contextMenuNode = node;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'node-context-menu';

  const isPinned = node.fx !== undefined && node.fx !== null;

  menu.innerHTML = `
    <div class="context-menu-item" data-action="expand">
      <span>🔍</span> Expand Node
    </div>
    <div class="context-menu-item" data-action="pin">
      <span>${isPinned ? '📌' : '📍'}</span> ${isPinned ? 'Unpin Node' : 'Pin Node'}
    </div>
    <div class="context-menu-item" data-action="info">
      <span>ℹ️</span> Show Info
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" data-action="delete">
      <span>🗑️</span> Remove Node
    </div>
  `;

  document.body.appendChild(menu);

  // Position menu
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  let x = event.clientX;
  let y = event.clientY;

  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 10;
  }
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 10;
  }

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // Add click handlers
  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', () => handleContextMenuAction(item.dataset.action));
  });
}

function hideContextMenu() {
  const menu = document.getElementById('node-context-menu');
  if (menu) {
    menu.remove();
  }
  contextMenuNode = null;
}

function handleContextMenuAction(action) {
  const node = contextMenuNode;
  hideContextMenu();

  if (!node) return;

  switch (action) {
    case 'expand':
      expandNode(node);
      break;
    case 'pin':
      togglePinNode(node);
      break;
    case 'info':
      showNodeInfo(node);
      break;
    case 'delete':
      deleteNode(node);
      break;
  }
}

function togglePinNode(node) {
  const nodeGroup = d3.select("#visualization")
    .selectAll(".node-group")
    .filter(d => d.name === node.name);

  if (node.fx !== undefined && node.fx !== null) {
    delete node.fx;
    delete node.fy;
    nodeGroup.classed("fixed", false);
  } else {
    node.fx = node.x;
    node.fy = node.y;
    nodeGroup.classed("fixed", true);
  }
  simulation.alpha(0.3).restart();
}

function deleteNode(node) {
  if (node.level === 0) {
    alert("Cannot delete the root node");
    return;
  }

  // Remove from simulation
  const nodes = simulation.nodes().filter(n => n.name !== node.name);
  const links = simulation.force("link").links().filter(l =>
    l.source.name !== node.name && l.target.name !== node.name
  );

  simulation.nodes(nodes);
  simulation.force("link").links(links);

  // Remove from DOM
  d3.select("#visualization")
    .selectAll(".node-group")
    .filter(d => d.name === node.name)
    .remove();

  d3.select("#visualization")
    .selectAll(".link-container line")
    .filter(d => d.source.name === node.name || d.target.name === node.name)
    .remove();

  // Update currentGraphData
  if (currentGraphData) {
    currentGraphData.nodes = nodes;
    currentGraphData.links = links;
  }

  existingNodes.delete(node.name);
  simulation.alpha(0.3).restart();
}

function expandNode(node) {
  console.log("Expanding node:", node.name);

  // Show loading state
  const nodeGroup = d3.select("#visualization")
    .selectAll(".node-group")
    .filter(d => d.name === node.name);
  nodeGroup.classed("expanding", true);

  // Fetch expanded data from backend (uses form data, not JSON)
  // Note: backend subtracts 1 from depth, so depth=2 gives us root+children
  const formData = new FormData();
  formData.append('article_name', node.name);
  formData.append('search_source', 'wikipedia');
  formData.append('depth', '2');

  fetch("/visualize", {
    method: "POST",
    body: formData
  })
  .then(response => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let incompleteChunk = "";

    function read() {
      return reader.read().then(({ done, value }) => {
        if (done) {
          nodeGroup.classed("expanding", false);
          console.log("Expand complete for:", node.name);
          return;
        }

        const text = decoder.decode(value).trim();
        const chunks = text.split("\n\n");

        for (const chunk of chunks) {
          if (!chunk) continue;
          try {
            const data = JSON.parse(incompleteChunk + chunk);
            incompleteChunk = "";

            // Skip stream_id chunk
            if (data.stream_id) {
              console.log("Expand stream started:", data.stream_id);
              continue;
            }

            if (data.nodes && data.links) {
              console.log("Merging data:", data.nodes.length, "nodes,", data.links.length, "links");
              mergeGraphData(data, node);
            }
          } catch (e) {
            // Incomplete chunk, save for next iteration
            incompleteChunk += chunk;
          }
        }
        return read();
      });
    }
    return read();
  })
  .catch(error => {
    console.error("Error expanding node:", error);
    nodeGroup.classed("expanding", false);
  });
}

function mergeGraphData(newData, parentNode) {
  // Get current nodes and links
  const currentNodes = simulation.nodes();
  const currentLinks = simulation.force("link").links();

  const existingNodeNames = new Set(currentNodes.map(n => n.name));

  // Add new nodes (skip if already exists)
  const nodesToAdd = [];
  for (const newNode of newData.nodes) {
    if (!existingNodeNames.has(newNode.name)) {
      // Position near parent
      newNode.x = parentNode.x + (Math.random() - 0.5) * 100;
      newNode.y = parentNode.y + (Math.random() - 0.5) * 100;
      newNode.level = parentNode.level + 1;
      nodesToAdd.push(newNode);
      existingNodeNames.add(newNode.name);
    }
  }

  // Normalize ALL existing links back to string names (D3 converts them to objects)
  const normalizedCurrentLinks = currentLinks.map(l => ({
    source: l.source.name || l.source,
    target: l.target.name || l.target
  }));

  const existingLinkKeys = new Set(normalizedCurrentLinks.map(l =>
    `${l.source}-${l.target}`
  ));

  // Add new links (skip duplicates)
  const linksToAdd = [];
  for (const link of newData.links) {
    const sourceName = typeof link.source === 'string' ? link.source : link.source.name;
    const targetName = typeof link.target === 'string' ? link.target : link.target.name;
    const key = `${sourceName}-${targetName}`;
    const reverseKey = `${targetName}-${sourceName}`;

    if (!existingLinkKeys.has(key) && !existingLinkKeys.has(reverseKey)) {
      // Only add if both nodes exist
      if (existingNodeNames.has(sourceName) && existingNodeNames.has(targetName)) {
        linksToAdd.push({ source: sourceName, target: targetName });
        existingLinkKeys.add(key);
      }
    }
  }

  if (nodesToAdd.length === 0 && linksToAdd.length === 0) {
    return;
  }

  // Merge nodes and links - use normalized string-based links
  const allNodes = [...currentNodes, ...nodesToAdd];
  const allLinks = [...normalizedCurrentLinks, ...linksToAdd];

  // Update visualization with all string-based links (D3 will resolve them)
  visualized3({ nodes: allNodes, links: allLinks });
}

/**
 * Open the article beside the graph rather than in a new tab.
 *
 * The panel markup was already in the page but nothing filled it; Show Info
 * just opened Wikipedia and lost the graph. This fetches the article's own
 * summary and lead section from Wikipedia's REST API, which is CORS-open, so
 * the reading happens next to the thing being read about.
 */
function titleFromNode(node) {
  // node.url is a /wiki/Title link; fall back to the label
  try {
    const u = new URL(node.url);
    const m = u.pathname.match(/\/wiki\/(.+)$/);
    if (m) return decodeURIComponent(m[1]).replace(/_/g, " ");
  } catch (e) {}
  return node.name;
}

function showNodeInfo(node) {
  // The static #contextMenu in the template calls this with no argument, so
  // fall back to whichever node the menu was opened on.
  node = node || contextMenuNode || selectedNode;
  if (!node) return;
  const panel = document.getElementById("infoPanel");
  if (!panel) { window.open(node.url, "_blank"); return; }

  const title = titleFromNode(node);
  document.getElementById("infoPanelTitle").textContent = title;
  const lvl = document.getElementById("infoPanelLevel");
  if (lvl) lvl.textContent = "Level " + (node.level != null ? node.level : "?");
  const link = document.getElementById("infoPanelLink");
  if (link) link.href = node.url || "#";

  const body = document.getElementById("infoPanelAbstract");
  body.innerHTML = '<div class="info-panel-loading">Loading article…</div>';
  panel.classList.add("open");
  panel.classList.remove("collapsed");

  const api = "https://en.wikipedia.org/api/rest_v1/page/";
  fetch(api + "summary/" + encodeURIComponent(title))
    .then((r) => (r.ok ? r.json() : null))
    .then((sum) => {
      if (!sum) throw new Error("no summary");
      let html = "";
      if (sum.thumbnail && sum.thumbnail.source) {
        html += '<img class="info-panel-thumb" src="' + sum.thumbnail.source +
                '" alt="">';
      }
      html += '<p class="info-panel-lead">' + (sum.extract || "") + "</p>";
      body.innerHTML = html;
      // then the fuller lead section, so the panel reads like the article
      return fetch(api + "html/" + encodeURIComponent(title));
    })
    .then((r) => (r && r.ok ? r.text() : null))
    .then((html) => {
      if (!html) return;
      const doc = new DOMParser().parseFromString(html, "text/html");
      const paras = [...doc.querySelectorAll("section:first-of-type > p")]
        .map((el) => el.textContent.trim())
        .filter((t) => t.length > 80)
        .slice(1, 5);
      if (!paras.length) return;
      const more = document.createElement("div");
      more.className = "info-panel-more";
      more.innerHTML = paras.map((t) => "<p>" + t + "</p>").join("");
      body.appendChild(more);
    })
    .catch(() => {
      body.innerHTML = '<p class="info-panel-lead">Could not load that article. ' +
        '<a href="' + (node.url || "#") + '" target="_blank" rel="noopener">' +
        "Open it on Wikipedia</a>.</p>";
    });
}

function closeInfoPanel() {
  const panel = document.getElementById("infoPanel");
  if (panel) panel.classList.remove("open");
}

function toggleInfoPanel() {
  const panel = document.getElementById("infoPanel");
  if (panel) panel.classList.toggle("collapsed");
}

// Close context menu on click outside or escape key
document.addEventListener('click', (e) => {
  if (!e.target.closest('.context-menu')) {
    hideContextMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu();
  }
});

/**
 * Recolour what is already on screen. The toggle calls this.
 *
 * It does NOT re-run visualized3. By the time a graph is drawn, d3 has
 * rewritten every link's source and target from a name into the node object
 * itself, so feeding that data back in appends a second copy of the graph and
 * the links stop lining up with the nodes. Only the palette changed, so only
 * the attributes need to change.
 */
function rethemeGraph() {
  const svg = d3.select("#visualization");
  if (svg.empty()) return;
  const p = pal();

  svg.selectAll("line")
    .attr("stroke", p.link)
    .attr("stroke-opacity", p.linkOpacity);

  svg.selectAll("rect").each(function (d) {
    if (!d) return;
    const r = d3.select(this);
    if (d.level === 0) {
      r.attr("fill", p.rootFill);
    }
    // a border that was only there to separate a node from the background
    // follows the theme; a border carrying group meaning is left alone
    const stroke = r.attr("stroke");
    if (!stroke || stroke === "#48607f" || stroke === "none" || stroke === "null") {
      r.attr("stroke", p.nodeStroke);
    }
  });

  svg.selectAll("text.text-item").each(function (d) {
    if (!d) return;
    d3.select(this).attr("fill", d.level === 0 ? p.rootText : p.nodeText);
  });
}
