"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { Dimension, GradeResult } from "@/lib/types";

const DIMENSION_COLORS: Record<Dimension, number> = {
  "时态": 0xe7c66a,
  "介词搭配": 0x75b7ff,
  "定语从句": 0x62d48b,
  "连接词": 0xf1c95b,
  "被动语态": 0xff9f76,
  "冠词": 0xb7a7ff
};

export default function AbilityMotionField({
  dimension,
  progress,
  total,
  verdict
}: {
  dimension: Dimension;
  progress: number;
  total: number;
  verdict?: GradeResult["verdict"];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const container = host;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    camera.position.z = 6;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearAlpha(0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    container.appendChild(renderer.domElement);

    const count = Math.min(56, 22 + Math.round((progress / Math.max(1, total)) * 24) + (verdict ? 8 : 0));
    const color = new THREE.Color(DIMENSION_COLORS[dimension]);
    const positions = new Float32Array(count * 3);
    const seeds = Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2;
      const radius = 1.1 + (index % 9) * 0.24;
      return { angle, radius, z: ((index % 7) - 3) * 0.34 };
    });

    seeds.forEach((seed, index) => {
      positions[index * 3] = Math.cos(seed.angle) * seed.radius;
      positions[index * 3 + 1] = Math.sin(seed.angle) * seed.radius * 0.68;
      positions[index * 3 + 2] = seed.z;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color,
        size: verdict === "wrong" ? 0.055 : 0.045,
        transparent: true,
        opacity: verdict === "correct" ? 0.36 : verdict === "wrong" ? 0.28 : 0.24,
        depthWrite: false
      })
    );
    scene.add(points);

    const linePositions: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const next = (index + 3) % count;
      linePositions.push(
        positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2],
        positions[next * 3], positions[next * 3 + 1], positions[next * 3 + 2]
      );
    }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
    const lines = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.09,
        depthWrite: false
      })
    );
    scene.add(lines);

    let frame = 0;
    let width = 0;
    let height = 0;
    let animationId = 0;

    function resize() {
      const rect = container.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    function render() {
      if (!reducedMotion) {
        frame += 0.006;
        points.rotation.z = frame;
        lines.rotation.z = frame * 0.7;
        points.rotation.x = Math.sin(frame * 0.8) * 0.08;
      }
      renderer.render(scene, camera);
      if (!reducedMotion) animationId = window.requestAnimationFrame(render);
    }

    resize();
    render();
    const observer = new ResizeObserver(() => {
      resize();
      renderer.render(scene, camera);
    });
    observer.observe(container);

    return () => {
      if (animationId) window.cancelAnimationFrame(animationId);
      observer.disconnect();
      container.removeChild(renderer.domElement);
      geometry.dispose();
      lineGeometry.dispose();
      (points.material as THREE.Material).dispose();
      (lines.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, [dimension, progress, total, verdict]);

  return <div className="ability-motion-field" ref={hostRef} aria-hidden="true" />;
}
