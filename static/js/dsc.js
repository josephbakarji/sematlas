// Configuration constants
const DSC_CONFIG = {
    ZOOM_SEARCH_DURATION: 500,
    NBODY_CHARGE: -800,           
    LINK_DISTANCE: 150,           
    LINK_STRENGTH: 0.3,           
    COLLISON_PADDING: 10,        
    PADDING: 30,                 
    TEXT_PADDING: 8,              
    LINK_WIDTH: 5,
    LINK_OPACITY: 0.2,
    REC_FILLET: 5,
    BACKGROUND_COLOR: "#f5f5f5",
    LINK_COLOR: "black",
    CENTER_FORCE_STRENGTH: 0.05,  
    FONT_SIZES: {
        'question': '28px',
        'course': '24px',
        'topic': '20px',
        'skill': '18px'
    },
    FONT_WEIGHTS: {
        'question': 'bold',
        'course': 'bold',
        'topic': 'normal',
        'skill': 'normal'
    }
};

// Only declare meta if it doesn't exist
if (typeof window.dscMeta === 'undefined') {
    window.dscMeta = {};
}

function metaFor(node) {
    return window.dscMeta[node.id];
}

function visualizeDSC(data, create = true) {
    // Store positions of existing nodes
    const existingPositions = new Map();
    if (!create) {
        d3.selectAll(".node-container g").each(function(d) {
            if (d && !isNaN(d.x) && !isNaN(d.y)) {
                existingPositions.set(d.id, {x: d.x, y: d.y});
            }
        });
    }

    // Initialize positions for nodes
    data.nodes.forEach(node => {
        if (existingPositions.has(node.id)) {
            const pos = existingPositions.get(node.id);
            node.x = pos.x;
            node.y = pos.y;
            node.fx = pos.x;
            node.fy = pos.y;
        }
    });

    // Clear existing visualization
    const svg = d3.select("svg");
    svg.selectAll("*").remove();

    // Get dimensions
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Add zoom behavior
    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on("start", () => {
            svg.style("cursor", "grabbing");
        })
        .on("end", () => {
            svg.style("cursor", "default");
        })
        .on("zoom", zoomed);

    svg.call(zoom);
    svg.on("dblclick.zoom", null);  // Disable double-click zoom

    // Create a group for all visualization content
    const g = svg.append("g").attr("id", "viz_content");

    // Create containers for links and nodes
    const linkGroup = g.append("g").attr("class", "link-container");
    const nodeGroup = g.append("g").attr("class", "node-container");

    // Create the force simulation with optimized forces
    const simulation = d3.forceSimulation()
        .force("link", d3.forceLink().id(d => d.id)
            .distance(DSC_CONFIG.LINK_DISTANCE)
            .strength(DSC_CONFIG.LINK_STRENGTH))
        .force("charge", d3.forceManyBody()
            .strength(DSC_CONFIG.NBODY_CHARGE)
            .distanceMax(500))
        .force("center", d3.forceCenter(width / 2, height / 2)
            .strength(DSC_CONFIG.CENTER_FORCE_STRENGTH))
        .force("x", d3.forceX(width / 2).strength(0.03))
        .force("y", d3.forceY(height / 2).strength(0.03))
        .force("collide", forceCollide())
        .alphaDecay(0.01)
        .velocityDecay(0.3);

    // Add links
    const link = linkGroup
        .selectAll("line")
        .data(data.links)
        .enter()
        .append("line")
        .attr("stroke", DSC_CONFIG.LINK_COLOR)
        .attr("stroke-opacity", DSC_CONFIG.LINK_OPACITY)
        .attr("stroke-width", DSC_CONFIG.LINK_WIDTH);

    // Add nodes
    const node = nodeGroup
        .selectAll("g")
        .data(data.nodes)
        .enter()
        .append("g")
        .call(drag(simulation));

    // Create hyperlinks for nodes
    const hyperlink = node
        .append("a")
        .attr("href", d => d.url)
        .attr("target", "_blank");

    // Add click handlers
    hyperlink.on("dblclick", function(event, d) {
        window.open(d.url, "_blank");
    });

    hyperlink.on("click", function(event) {
        event.preventDefault();
    });

    // Add rectangles for nodes
    hyperlink
        .append("rect")
        .attr("rx", DSC_CONFIG.REC_FILLET)
        .attr("fill", d => d.color || "white")
        .attr("stroke", d => d.color || DSC_CONFIG.LINK_COLOR)
        .attr("stroke-width", 3);

    // Add text labels
    hyperlink
        .append("text")
        .text(d => d.name)
        .attr("fill", "black")
        .attr("font-size", d => DSC_CONFIG.FONT_SIZES[d.type] || '18px')
        .attr("font-weight", d => DSC_CONFIG.FONT_WEIGHTS[d.type] || 'normal');

    // Calculate and set node dimensions
    hyperlink.each(function(d) {
        const bbox = this.getBBox();
        d.width = bbox.width + 2 * DSC_CONFIG.TEXT_PADDING;
        d.height = bbox.height + 2 * DSC_CONFIG.TEXT_PADDING;
        
        d3.select(this)
            .select("rect")
            .attr("width", d.width)
            .attr("height", d.height)
            .attr("x", -d.width / 2)
            .attr("y", -d.height / 2);

        d3.select(this)
            .select("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle");
    });

    // Update simulation nodes and links
    simulation.nodes(data.nodes);
    simulation.force("link").links(data.links);

    // Update simulation on tick
    simulation.on("tick", () => {
        // Use transform attribute instead of x/y for better performance
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node.attr("transform", d => `translate(${d.x},${d.y})`);

        // Only reheat simulation if really needed
        if (simulation.alpha() < 0.01) {
            simulation.alpha(0.1);
        }
    });

    // Release fixed positions after a delay
    setTimeout(() => {
        data.nodes.forEach(node => {
            node.fx = null;
            node.fy = null;
        });
    }, 1000);

    // Zoom function
    function zoomed(event) {
        g.attr("transform", event.transform);
    }

    // Drag functions
    function drag(simulation) {
        function dragstarted(event) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            event.subject.fx = event.subject.x;
            event.subject.fy = event.subject.y;
        }

        function dragged(event) {
            event.subject.fx = event.x;
            event.subject.fy = event.y;
        }

        function dragended(event) {
            if (!event.active) simulation.alphaTarget(0);
            event.subject.fx = null;
            event.subject.fy = null;
        }

        return d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended);
    }

    // Collision force function
    function forceCollide() {
        let nodes;
        const padding = DSC_CONFIG.PADDING;

        function force(alpha) {
            const quad = d3.quadtree(nodes, d => d.x, d => d.y);
            
            for (const d of nodes) {
                quad.visit((q, x1, y1, x2, y2) => {
                    if (!q.data || q.data === d) return;

                    let x = d.x - q.data.x,
                        y = d.y - q.data.y,
                        xSpacing = padding + (q.data.width + d.width) / 2,
                        ySpacing = padding + (q.data.height + d.height) / 2,
                        absX = Math.abs(x),
                        absY = Math.abs(y);

                    if (absX < xSpacing && absY < ySpacing) {
                        const l = Math.sqrt(x * x + y * y);
                        const lx = (absX - xSpacing) / l * alpha * 0.5;
                        const ly = (absY - ySpacing) / l * alpha * 0.5;

                        d.x -= x * lx;
                        d.y -= y * ly;
                        q.data.x += x * lx;
                        q.data.y += ly;
                    }

                    return absX > xSpacing || absY > ySpacing;
                });
            }
        }

        force.initialize = _ => nodes = _;
        return force;
    }

    // Handle window resizing
    window.addEventListener('resize', () => {
        const width = window.innerWidth;
        const height = window.innerHeight;
        svg
            .attr("width", width)
            .attr("height", height);
        simulation.force("center", d3.forceCenter(width / 2, height / 2));
        simulation.alpha(0.3).restart();
    });
}

// Wait for DOM to load
document.addEventListener('DOMContentLoaded', function() {
    // Initialize visualization if data is available
    if (window.initialData) {
        visualizeDSC(window.initialData);
    }

    window.handleFileUpload = async function() {
        const fileInput = document.getElementById('fileInput');
        const file = fileInput.files[0];
        
        if (!file) {
            Logger.warn('No file selected');
            return;
        }
        
        document.getElementById('loading-spinner').style.display = 'block';
        
        try {
            const formData = new FormData();
            formData.append('file', file);
            
            const response = await fetch('/upload_graph', {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Upload failed');
            }
            
            const data = await response.json();
            Logger.log('File uploaded successfully', data);
            window.initialData = data;
            visualizeDSC(data);
            
        } catch (error) {
            Logger.error('Upload failed', error);
            alert('Error uploading file: ' + error.message);
        } finally {
            document.getElementById('loading-spinner').style.display = 'none';
            fileInput.value = '';
        }
    };

    window.resetToDefault = function() {
        if (window.defaultData) {
            visualizeDSC(window.defaultData);
        } else {
            alert('Default data not available');
        }
    };

    // Update CSS for better visual feedback
    const style = document.createElement('style');
    style.textContent = `
        .fixed {
            cursor: pointer !important;
        }
        .fixed rect {
            stroke: #666;
            stroke-width: 2px;
        }
    `;
    document.head.appendChild(style);
});
