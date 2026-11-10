/**
 * Topologia da rede em 3D: cada equipamento num andar pela função (nuvem/trânsito
 * em cima, núcleo, agregação, transporte, POPs e OLTs embaixo), posição no plano por
 * simulação de forças nos enlaces. Enlaces cadastrados em linha cheia com pacotes
 * de tráfego correndo; ligações inferidas tracejadas. Alarme crítico pisca.
 */

import { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { Edges, Html, Line, OrbitControls, Stars } from '@react-three/drei';
import { QuadraticBezierCurve3, Vector3, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import type { DeviceStatus, TopoKind, TopoLink, TopoNode, TopologyGraph } from '../types';

export const STATUS_HEX: Record<DeviceStatus, string> = { ok: '#34d399', atencao: '#fbbf24', critico: '#f87171', desconhecido: '#3fc6ee' };
const LINK_HEX = { ok: '#12baea', alerta: '#f87171', desconhecido: '#64748b' } as const;
const LAYER_GAP = 1.7;

// ------------------------------------------------------------------ layout

/** Posições x/z por simulação de forças (determinística); y pelo andar. */
function layout(nodes: TopoNode[], links: TopoLink[]): { pos: Map<string, Vector3>; raio: number } {
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const porCamada = new Map<number, TopoNode[]>();
  for (const n of nodes) porCamada.set(n.camada, [...(porCamada.get(n.camada) ?? []), n]);
  // Começo: anel por andar.
  const pos = nodes.map((n) => {
    const grupo = porCamada.get(n.camada)!;
    const i = grupo.indexOf(n);
    const r = 1.5 + grupo.length * 0.45;
    const a = (i / grupo.length) * Math.PI * 2 + n.camada;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, vx: 0, vz: 0 };
  });
  const arestas = links.map((l) => [idx.get(l.de), idx.get(l.para), l.inferido ? 0.5 : 1] as const).filter(([a, b]) => a !== undefined && b !== undefined) as Array<[number, number, number]>;
  for (let it = 0; it < 320; it++) {
    const temp = 1 - it / 320;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[i].x - pos[j].x;
        const dz = pos[i].z - pos[j].z;
        const mesmoAndar = Math.abs(nodes[i].camada - nodes[j].camada) < 0.5;
        const d2 = Math.max(dx * dx + dz * dz, 0.05);
        const f = (mesmoAndar ? 2.6 : 0.9) / d2;
        pos[i].vx += dx * f; pos[i].vz += dz * f;
        pos[j].vx -= dx * f; pos[j].vz -= dz * f;
      }
    }
    for (const [a, b, w] of arestas) {
      const dx = pos[b].x - pos[a].x;
      const dz = pos[b].z - pos[a].z;
      const d = Math.sqrt(dx * dx + dz * dz) || 0.01;
      const f = (d - 2.2) * 0.06 * w;
      pos[a].vx += (dx / d) * f; pos[a].vz += (dz / d) * f;
      pos[b].vx -= (dx / d) * f; pos[b].vz -= (dz / d) * f;
    }
    for (const p of pos) {
      p.vx -= p.x * 0.012; p.vz -= p.z * 0.012;           // gravidade ao centro
      const lim = 0.6 * temp + 0.02;
      p.x += Math.max(-lim, Math.min(lim, p.vx)); p.z += Math.max(-lim, Math.min(lim, p.vz));
      p.vx *= 0.5; p.vz *= 0.5;
    }
  }
  // Normaliza o espalhamento para um raio que cabe na câmera.
  const raio = 4 + Math.sqrt(nodes.length) * 1.05;
  const cx = pos.reduce((a, p) => a + p.x, 0) / (pos.length || 1);
  const cz = pos.reduce((a, p) => a + p.z, 0) / (pos.length || 1);
  const maxR = Math.max(0.01, ...pos.map((p) => Math.hypot(p.x - cx, p.z - cz)));
  const k = raio / maxR;
  return { pos: new Map(nodes.map((n, i) => [n.id, new Vector3((pos[i].x - cx) * k, n.camada * LAYER_GAP, (pos[i].z - cz) * k)])), raio };
}

// ------------------------------------------------------------------ nós

function Shape({ tipo }: { tipo: TopoKind }) {
  const metal = <meshStandardMaterial color="#16223b" metalness={0.65} roughness={0.32} />;
  switch (tipo) {
    case 'roteador': return <mesh><boxGeometry args={[0.95, 0.26, 0.62]} />{metal}<Edges color="#6b5cff" /></mesh>;
    case 'switch': return <mesh><boxGeometry args={[0.95, 0.16, 0.5]} />{metal}<Edges color="#12baea" /></mesh>;
    case 'olt': return <mesh><boxGeometry args={[0.5, 0.85, 0.5]} />{metal}<Edges color="#12baea" /></mesh>;
    case 'servidor': return <mesh><boxGeometry args={[0.42, 0.62, 0.5]} />{metal}<Edges color="#c874f8" /></mesh>;
    case 'transporte': return <mesh><cylinderGeometry args={[0.32, 0.32, 0.3, 24]} />{metal}<Edges color="#fbbf24" threshold={30} /></mesh>;
    case 'onu': return <mesh><boxGeometry args={[0.4, 0.12, 0.3]} /><meshStandardMaterial color="#e2e8f0" /><Edges color="#12baea" /></mesh>;
    case 'nuvem': return (
      <group>
        {[[0, 0, 0, 0.55], [0.5, -0.1, 0.1, 0.42], [-0.5, -0.1, -0.1, 0.42], [0.15, 0.25, -0.3, 0.38]].map(([x, y, z, r], i) => (
          <mesh key={i} position={[x, y, z]}><sphereGeometry args={[r, 24, 24]} /><meshStandardMaterial color="#3fc6ee" transparent opacity={0.28} emissive="#0ea3d0" emissiveIntensity={0.5} /></mesh>
        ))}
      </group>
    );
    case 'servico': return <mesh><icosahedronGeometry args={[0.38, 1]} /><meshStandardMaterial color="#c874f8" wireframe emissive="#c874f8" emissiveIntensity={0.6} /></mesh>;
    case 'site': return <mesh><octahedronGeometry args={[0.3]} /><meshStandardMaterial color="#12baea" wireframe emissive="#12baea" emissiveIntensity={0.5} /></mesh>;
    default: return <mesh><sphereGeometry args={[0.24, 20, 20]} />{metal}<Edges color="#64748b" threshold={40} /></mesh>;
  }
}

function Node({ node, position, selected, dim, showLabel, onSelect }: {
  node: TopoNode; position: Vector3; selected: boolean; dim: boolean; showLabel: boolean; onSelect: (id: string) => void;
}) {
  const group = useRef<Group>(null);
  const led = useRef<MeshStandardMaterial>(null);
  const ring = useRef<Mesh>(null);
  const [hover, setHover] = useState(false);
  const color = STATUS_HEX[node.status];
  const fase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (group.current) {
      group.current.position.y = position.y + Math.sin(t * 1.1 + fase) * 0.05;
      const s = selected ? 1.35 : hover ? 1.18 : 1;
      group.current.scale.lerp(new Vector3(s, s, s), 0.2);
    }
    if (led.current) led.current.emissiveIntensity = node.status === 'critico' ? (Math.sin(t * 6 + fase) > 0 ? 3 : 0.3) : 1.6;
    if (ring.current) {
      const k = 1 + ((t * (node.status === 'critico' ? 1.4 : 0.5) + fase) % 1) * 0.9;
      ring.current.scale.set(k, k, k);
      (ring.current.material as MeshStandardMaterial).opacity = (node.status === 'critico' ? 0.7 : 0.35) * (1 - (k - 1) / 0.9);
    }
  });

  const click = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(node.id); };
  return (
    <group
      ref={group}
      position={[position.x, position.y, position.z]}
      onClick={click}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}
    >
      <group visible={!dim || selected}>
        <Shape tipo={node.tipo} />
      </group>
      {dim && !selected && <mesh><sphereGeometry args={[0.12, 10, 10]} /><meshBasicMaterial color="#334155" /></mesh>}
      {/* LED de estado */}
      <mesh position={[0, node.tipo === 'olt' ? 0.55 : node.tipo === 'nuvem' ? 0.7 : 0.3, 0]}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshStandardMaterial ref={led} color={color} emissive={color} emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
      {/* onda no chão do nó */}
      {(node.status === 'critico' || node.status === 'atencao' || selected) && (
        <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.3, 0]}>
          <ringGeometry args={[0.45, 0.52, 40]} />
          <meshStandardMaterial color={selected ? '#e0f2fe' : color} emissive={selected ? '#e0f2fe' : color} transparent opacity={0.5} toneMapped={false} />
        </mesh>
      )}
      {(showLabel || hover || selected) && (
        <Html center distanceFactor={22} position={[0, node.tipo === 'olt' ? 0.85 : 0.6, 0]} style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
          <div className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-[10px] backdrop-blur ${selected ? 'border-cyan-300/70 bg-cyan-400/20 text-cyan-50' : 'border-slate-600/50 bg-slate-950/70 text-slate-200'}`}>
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: color }} />
            {node.nome}{node.agrupados ? ` (${node.agrupados})` : ''}
          </div>
        </Html>
      )}
    </group>
  );
}

// ------------------------------------------------------------------ enlaces

function Packets({ curve, color, speed, count }: { curve: QuadraticBezierCurve3; color: string; speed: number; count: number }) {
  const refs = useRef<Array<Mesh | null>>([]);
  const offsets = useMemo(() => Array.from({ length: count }, (_, i) => i / count + Math.random() * 0.1), [count]);
  useFrame(({ clock }) => {
    refs.current.forEach((m, i) => {
      if (!m) return;
      const u = (clock.elapsedTime * speed + offsets[i]) % 1;
      m.position.copy(curve.getPoint(u));
    });
  });
  return (
    <>
      {offsets.map((_, i) => (
        <mesh key={i} ref={(el) => { refs.current[i] = el; }}>
          <sphereGeometry args={[0.045, 8, 8]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

function Link({ link, a, b, highlight, dim }: { link: TopoLink; a: Vector3; b: Vector3; highlight: boolean; dim: boolean }) {
  const curve = useMemo(() => {
    const mid = a.clone().lerp(b, 0.5);
    mid.y += 0.35 + a.distanceTo(b) * 0.06;
    return new QuadraticBezierCurve3(a, mid, b);
  }, [a, b]);
  const points = useMemo(() => curve.getPoints(24), [curve]);
  const color = highlight ? '#e0f2fe' : LINK_HEX[link.status];
  const largura = (link.gbps ? 1 + Math.log10(link.gbps + 1) * 1.6 : 1.2) * (highlight ? 1.6 : 1);
  return (
    <>
      <Line
        points={points}
        color={color}
        lineWidth={largura}
        transparent
        opacity={dim ? 0.12 : link.inferido ? 0.45 : 0.85}
        dashed={link.inferido}
        dashSize={0.18}
        gapSize={0.14}
      />
      {!dim && (
        <Packets
          curve={curve}
          color={link.status === 'alerta' ? '#fca5a5' : link.inferido ? '#94a3b8' : '#5fd2f3'}
          speed={link.inferido ? 0.12 : 0.18 + Math.min(0.5, (link.gbps ?? 1) / 120)}
          count={link.inferido ? 1 : 3}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ cena

export default function Topology3D({ graph, selected, onSelect, showInferred, showLabels, onlyAlarms }: {
  graph: TopologyGraph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  showInferred: boolean;
  showLabels: boolean;
  onlyAlarms: boolean;
}) {
  const links = useMemo(() => graph.links.filter((l) => showInferred || !l.inferido), [graph, showInferred]);
  const { pos: positions, raio } = useMemo(() => layout(graph.nodes, graph.links), [graph]);
  const vizinhos = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const l of graph.links) { if (l.de === selected) s.add(l.para); if (l.para === selected) s.add(l.de); }
    return s;
  }, [graph, selected]);
  const minY = Math.min(...graph.nodes.map((n) => n.camada)) * LAYER_GAP - 0.9;
  const centroY = (Math.max(...graph.nodes.map((n) => n.camada)) * LAYER_GAP + minY) / 2;

  return (
    <Canvas dpr={[1, 2]} camera={{ position: [0, centroY + raio * 0.75, raio * 2.1], fov: 45 }} gl={{ antialias: true, alpha: true }} onPointerMissed={() => onSelect(null)}>
      <fog attach="fog" args={['#05021a', raio * 2, raio * 4.5]} />
      <ambientLight intensity={0.7} />
      <hemisphereLight args={['#8ddcf5', '#0b1324', 0.6]} />
      <pointLight position={[8, 12, 8]} intensity={160} color="#8ddcf5" />
      <pointLight position={[-10, 4, -6]} intensity={80} color="#c874f8" />
      <Stars radius={60} depth={30} count={1800} factor={3} fade speed={0.6} />
      <gridHelper args={[60, 60, '#155e75', '#0c2a3a']} position={[0, minY, 0]} />

      {links.map((l, i) => {
        const a = positions.get(l.de); const b = positions.get(l.para);
        if (!a || !b) return null;
        const hl = Boolean(selected && (l.de === selected || l.para === selected));
        const dim = Boolean((vizinhos && !hl) || (onlyAlarms && l.status !== 'alerta'));
        return <Link key={`${l.de}-${l.para}-${i}`} link={l} a={a} b={b} highlight={hl} dim={dim} />;
      })}
      {graph.nodes.map((n) => {
        const p = positions.get(n.id)!;
        const alarme = n.status === 'critico' || n.status === 'atencao';
        const dim = Boolean((vizinhos && !vizinhos.has(n.id)) || (onlyAlarms && !alarme));
        const label = showLabels && (n.origem !== 'zabbix' || alarme || Boolean(vizinhos?.has(n.id)));
        return <Node key={n.id} node={n} position={p} selected={selected === n.id} dim={dim} showLabel={label && !dim} onSelect={onSelect} />;
      })}

      <OrbitControls makeDefault autoRotate={!selected} autoRotateSpeed={0.35} enableDamping dampingFactor={0.08} minDistance={4} maxDistance={raio * 4} target={[0, centroY, 0]} />
    </Canvas>
  );
}
