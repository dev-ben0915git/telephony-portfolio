'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export function CellTowerScene() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070b13, 0.02);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200);
    camera.position.set(0, 6, 18);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x070b13, 0);
    container.appendChild(renderer.domElement);

    // Honeycomb rotating grid (hex-like wireframe)
    const gridGroup = new THREE.Group();

    const radius = 11;
    const segments = 48;
    const ring = new THREE.RingGeometry(radius * 0.95, radius, segments, 1);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
    });
    const ringMesh = new THREE.Mesh(ring, ringMat);
    ringMesh.rotation.x = -Math.PI / 2.4;
    gridGroup.add(ringMesh);

    for (let i = 1; i <= 3; i++) {
      const r = new THREE.RingGeometry(i * 2.2, i * 2.2 + 0.05, 48, 1);
      const m = new THREE.MeshBasicMaterial({
        color: 0x00d4ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.12,
      });
      const mesh = new THREE.Mesh(r, m);
      mesh.rotation.x = -Math.PI / 2.4;
      gridGroup.add(mesh);
    }

    // Hex grid points
    const pointsGeo = new THREE.BufferGeometry();
    const positions: number[] = [];
    const hexR = 1.5;
    const gridSize = 7;
    for (let q = -gridSize; q <= gridSize; q++) {
      for (let r = -gridSize; r <= gridSize; r++) {
        const s = -q - r;
        if (Math.abs(s) > gridSize) continue;
        const x = hexR * (3 / 2) * q;
        const y = 0;
        const z = hexR * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
        if (Math.hypot(x, z) > radius) continue;
        positions.push(x, y, z);
      }
    }
    pointsGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const pointsMat = new THREE.PointsMaterial({
      color: 0x6ae4ff,
      size: 0.12,
      transparent: true,
      opacity: 0.85,
    });
    const points = new THREE.Points(pointsGeo, pointsMat);
    gridGroup.add(points);
    scene.add(gridGroup);

    // Tower: central triangular tower + antenna bars
    const towerGroup = new THREE.Group();
    const towerGeo = new THREE.ConeGeometry(0.4, 6, 4, 1, true);
    const towerMat = new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
    });
    const tower = new THREE.Mesh(towerGeo, towerMat);
    tower.position.y = 3;
    towerGroup.add(tower);

    // antenna dishes
    for (let i = 0; i < 3; i++) {
      const dish = new THREE.Mesh(
        new THREE.TorusGeometry(0.35, 0.06, 12, 24),
        new THREE.MeshBasicMaterial({
          color: 0x00d4ff,
          transparent: true,
          opacity: 0.8,
        }),
      );
      dish.position.y = 5 - i * 0.9;
      dish.position.x = Math.cos((i / 3) * Math.PI * 2) * 0.5;
      dish.position.z = Math.sin((i / 3) * Math.PI * 2) * 0.5;
      dish.rotation.x = Math.PI / 2;
      towerGroup.add(dish);
    }
    scene.add(towerGroup);

    // Pulse rings
    const pulses: THREE.Mesh[] = [];
    const spawnPulse = () => {
      const geo = new THREE.RingGeometry(0.1, 0.15, 48, 1);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00d4ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2.4;
      mesh.userData.life = 0;
      mesh.userData.max = 3.6;
      scene.add(mesh);
      pulses.push(mesh);
    };

    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    let pulseTimer = 0;
    let t = 0;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      t += 0.008;
      gridGroup.rotation.y = t * 0.6;
      towerGroup.rotation.y = t * 0.3;
      towerGroup.position.y = Math.sin(t * 1.6) * 0.1;
      camera.position.x = Math.sin(t * 0.2) * 1.5;
      camera.lookAt(0, 1.5, 0);

      pulseTimer += 1;
      if (pulseTimer > 80) {
        pulseTimer = 0;
        spawnPulse();
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const m = pulses[i];
        m.userData.life += 0.02;
        const s = 1 + m.userData.life * 6;
        m.scale.set(s, s, s);
        (m.material as THREE.MeshBasicMaterial).opacity = Math.max(
          0,
          0.55 * (1 - m.userData.life / m.userData.max),
        );
        if (m.userData.life > m.userData.max) {
          scene.remove(m);
          (m.geometry as THREE.BufferGeometry).dispose();
          (m.material as THREE.Material).dispose();
          pulses.splice(i, 1);
        }
      }

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) (mesh.geometry as THREE.BufferGeometry).dispose();
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) (m as THREE.Material).dispose();
        }
      });
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-[320px] w-full overflow-hidden rounded-2xl border border-bg-line/80 bg-gradient-to-b from-bg-base via-bg-soft/80 to-bg-base"
      aria-hidden="true"
    >
      <div className="pointer-events-none absolute left-4 top-3 z-10 text-xs uppercase tracking-[0.3em] text-accent/80">
        cell_tower · 5G · signal
      </div>
      <div className="pointer-events-none absolute right-4 top-3 z-10 text-xs text-slate-500">
        BTS / gNB · eCPRI
      </div>
    </div>
  );
}
