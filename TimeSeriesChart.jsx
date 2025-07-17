import React, { useRef, useState, useEffect } from "react";
import * as d3 from "d3";
import { WINDOW_MS } from "./ruuvi";

// Generic time series chart for any value key
export default function TimeSeriesChart({ data, windowMs = WINDOW_MS, now, valueKey = "apparentTemperature", lineColor = "#fff", fillColorFn, heightRatio = 1 }) {
    const ref = useRef();
    const [width, setWidth] = useState(0);

    useEffect(() => {
        if (!ref.current) return;
        const parent = ref.current.parentElement;
        if (!parent) return;
        setWidth(parent.offsetWidth);
        const observer = new window.ResizeObserver(entries => {
            for (let entry of entries) {
                if (entry.contentRect) {
                    setWidth(entry.contentRect.width);
                }
            }
        });
        observer.observe(parent);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!ref.current || width === 0) return;
        let filtered = data.filter(d => now - d.ts <= windowMs);
        filtered = filtered.filter(d => (
            d[valueKey] !== null && typeof d[valueKey] === 'number' && !isNaN(d[valueKey])
        ));
        if (!filtered.length) return;
        const baseAspect = 0.35;
        const height = Math.round(width * baseAspect * heightRatio);
        const margin = { top: 10, right: 0, bottom: 24, left: 0 };
        const svg = d3.select(ref.current);
        svg.selectAll("*").remove();
        svg.attr("width", width).attr("height", height);
        const x = d3.scaleLinear()
            .domain([0, windowMs])
            .range([width - margin.right, margin.left]);
        const y = d3.scaleLinear()
            .domain([
                d3.min(filtered, d => d[valueKey]) - 2,
                d3.max(filtered, d => d[valueKey]) + 2
            ])
            .range([height - margin.bottom, margin.top]);

        // Y axis: inset numeric ticks only, right-aligned
        const yTicks = y.ticks(2);
        svg.selectAll('.y-inset-tick')
            .data(yTicks)
            .enter()
            .append('text')
            .attr('class', 'y-inset-tick')
            .attr('x', width - 5)
            .attr('y', d => y(d) + 5)
            .attr('fill', '#aaa')
            .attr('font-size', '0.8em')
            .attr('text-anchor', 'end')
            .text(d => d.toFixed(0));

        // Optional filled polygon with y-gradient fill
        if (typeof fillColorFn === 'function' && filtered.length > 1) {
            const gradientId = `gradient-${valueKey}`;
            const minVal = d3.min(filtered, d => d[valueKey]);
            const maxVal = d3.max(filtered, d => d[valueKey]);
            const minColor = fillColorFn(minVal);
            const maxColor = fillColorFn(maxVal);
            svg.select(`#${gradientId}`).remove();
            const defs = svg.append('defs');
            const grad = defs.append('linearGradient')
                .attr('id', gradientId)
                .attr('x1', '0%').attr('y1', '100%')
                .attr('x2', '0%').attr('y2', '0%');
            grad.append('stop')
                .attr('offset', '0%')
                .attr('stop-color', minColor)
                .attr('stop-opacity', 0.6);
            grad.append('stop')
                .attr('offset', '100%')
                .attr('stop-color', maxColor)
                .attr('stop-opacity', 0.6);
            const area = d3.area()
                .x(d => x(now - d.ts))
                .y0(y.range()[0])
                .y1(d => y(d[valueKey]))
                .defined(d => d[valueKey] !== null && !isNaN(d[valueKey]));
            svg.append('path')
                .datum(filtered)
                .attr('fill', `url(#${gradientId})`)
                .attr('stroke', 'none')
                .attr('d', area);
        }

        // Continuous line for all valueKeys
        if (filtered.length > 1) {
            const line = d3.line()
                .x(d => x(now - d.ts))
                .y(d => y(d[valueKey]))
                .defined(d => d[valueKey] !== null && !isNaN(d[valueKey]));
            svg.append('path')
                .datum(filtered)
                .attr('fill', 'none')
                .attr('stroke', lineColor)
                .attr('stroke-width', 1)
                .attr('opacity', 0.9)
                .attr('d', line);
        }

        // X axis (remove far end tick labels)
        const xTicks = Array.from({length: Math.floor(windowMs / 60000) + 1}, (_, i) => i * 60000)
            .filter(ms => ms !== 0 && ms !== windowMs);
        svg.append('g')
            .attr('transform', `translate(0,${height - margin.bottom})`)
            .call(d3.axisBottom(x)
                .tickValues(xTicks)
                .tickFormat(ms => `${Math.round(ms / 60000)}`)
            )
            .selectAll('text').attr('fill', '#aaa').attr('font-size', '1.1em');
        svg.selectAll('.domain, .tick line').attr('stroke', '#444');
    }, [data, width, windowMs, now, valueKey, lineColor, fillColorFn, heightRatio]);

    return <svg ref={ref} style={{ width: "100%", height: "auto", display: "block" }} />;
}
