/**
 * Aparelho em 3D (three.js / React Three Fiber), montado a partir do tipo e dos
 * dados consultados: portas com LED pelo status, alarmes piscando, chassi em
 * estilo holográfico (arestas em ciano), piso em grade e varredura. Gira sozinho;
 * arraste para girar, role para aproximar.
 *
 * Os modelos são procedurais (caixas e cilindros): representam o tipo do aparelho,
 * não o desenho exato do fabricante.
 */

import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Edges, OrbitControls, RoundedBox } from '@react-three/drei';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import type { DeviceCard, DevicePort, DeviceStatus } from '../types';

const STATUS_COLOR: Record<DeviceStatus, string> = {
  ok: '#34d399',
  atencao: '#fbbf24',
  critico: '#f87171',
  desconhecido: '#38bdf8',
};

const BODY = '#15213a';
const EDGE = '#22d3ee';

type LedState = 'on' | 'off' | 'alarm' | 'warn';

function portLed(p: DevicePort | undefined, device: DeviceCard): LedState {
  if (!p) return device.status === 'critico' ? 'alarm' : 'off';
  const s = p.status.toLowerCase();
  if (/falha|down|erro|los|alarm/.test(s)) return 'alarm';
  if (/conect|up|ativ|online/.test(s)) return 'on';
  return 'off';
}

const LED_COLOR: Record<LedState, string> = { on: '#34d399', off: '#1e293b', alarm: '#f87171', warn: '#fbbf24' };

/** LED com brilho; os de alarme piscam. */
function Led({ position, state, size = [0.05, 0.03, 0.02] }: { position: [number, number, number]; state: LedState; size?: [number, number, number] }) {
  const mat = useRef<MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (!mat.current) return;
    if (state === 'alarm') mat.current.emissiveIntensity = Math.sin(clock.elapsedTime * 7) > 0 ? 2.6 : 0.2;
    else if (state === 'on') mat.current.emissiveIntensity = 1.4 + Math.sin(clock.elapsedTime * 3 + position[0] * 9) * 0.35;
  });
  return (
    <mesh position={position}>
      <boxGeometry args={size} />
      <meshStandardMaterial ref={mat} color={LED_COLOR[state]} emissive={LED_COLOR[state]} emissiveIntensity={state === 'off' ? 0.05 : 1.4} toneMapped={false} />
    </mesh>
  );
}

function Chassis({ w, h, d, color = BODY }: { w: number; h: number; d: number; color?: string }) {
  return (
    <RoundedBox args={[w, h, d]} radius={0.03} smoothness={3}>
      <meshStandardMaterial color={color} metalness={0.75} roughness={0.32} />
      <Edges color={EDGE} threshold={20} />
    </RoundedBox>
  );
}

/** Fileira de portas (gaiola + LED) na frente do chassi. */
function PortRow({ count, width, y, z, ports, device, offset = 0, rows = 1, tall = false }: {
  count: number; width: number; y: number; z: number; ports?: DevicePort[]; device: DeviceCard; offset?: number; rows?: number; tall?: boolean;
}) {
  const perRow = Math.ceil(count / rows);
  const gap = width / perRow;
  const items = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const x = -width / 2 + gap / 2 + c * gap;
    const yy = y - r * (tall ? 0.16 : 0.12);
    const led = portLed(ports?.[offset + i], device);
    items.push(
      <group key={i} position={[x, yy, z]}>
        <mesh>
          <boxGeometry args={[gap * 0.72, tall ? 0.1 : 0.07, 0.02]} />
          <meshStandardMaterial color="#020617" metalness={0.4} roughness={0.6} />
        </mesh>
        <Led position={[0, tall ? 0.07 : 0.055, 0.005]} state={led} size={[gap * 0.3, 0.018, 0.012]} />
      </group>,
    );
  }
  return <>{items}</>;
}

function RackDevice({ device, units = 1, router = false }: { device: DeviceCard; units?: number; router?: boolean }) {
  const ports = device.portas;
  const count = Math.min(Math.max(ports?.length ?? (router ? 16 : 24), 8), 56);
  const h = 0.22 * units;
  const rows = count > 28 ? 2 : 1;
  return (
    <group>
      <Chassis w={3.2} h={h} d={1.6} />
      {/* orelhas de rack */}
      {[-1.68, 1.68].map((x) => (
        <mesh key={x} position={[x, 0, 0.78]}>
          <boxGeometry args={[0.16, h, 0.03]} />
          <meshStandardMaterial color="#1e293b" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
      <PortRow count={count} width={2.3} y={rows === 2 ? h / 2 - 0.07 : 0} z={0.81} ports={ports} device={device} rows={rows} />
      {/* painel de status */}
      <Led position={[1.38, 0.04, 0.81]} state={device.status === 'critico' ? 'alarm' : device.status === 'atencao' ? 'warn' : 'on'} size={[0.06, 0.03, 0.02]} />
      <Led position={[1.38, -0.04, 0.81]} state="on" size={[0.06, 0.03, 0.02]} />
      {router && (
        // fontes redundantes atrás
        [-0.8, 0.8].map((x) => (
          <mesh key={x} position={[x, 0, -0.82]}>
            <boxGeometry args={[0.9, h * 0.8, 0.05]} />
            <meshStandardMaterial color="#111c33" metalness={0.6} roughness={0.4} />
          </mesh>
        ))
      )}
      {/* faixa de acento */}
      <mesh position={[-1.4, 0, 0.805]}>
        <boxGeometry args={[0.16, h * 0.7, 0.01]} />
        <meshStandardMaterial color={router ? '#818cf8' : '#22d3ee'} emissive={router ? '#818cf8' : '#22d3ee'} emissiveIntensity={0.8} toneMapped={false} />
      </mesh>
    </group>
  );
}

function OltDevice({ device }: { device: DeviceCard }) {
  const slots = 8;
  const items = [];
  for (let s = 0; s < slots; s++) {
    const x = -1.2 + s * (2.4 / (slots - 1));
    const critical = device.status === 'critico' && s === 2;
    items.push(
      <group key={s} position={[x, 0.05, 0.81]}>
        <mesh>
          <boxGeometry args={[0.26, 1.6, 0.02]} />
          <meshStandardMaterial color="#0f1a30" metalness={0.6} roughness={0.4} />
        </mesh>
        {Array.from({ length: 16 }, (_, i) => (
          <Led key={i} position={[0, 0.7 - i * 0.09, 0.015]} state={critical && i % 3 === 0 ? 'alarm' : s < 6 ? 'on' : 'off'} size={[0.12, 0.022, 0.01]} />
        ))}
      </group>,
    );
  }
  return (
    <group position={[0, 0.2, 0]}>
      <Chassis w={3} h={2} d={1.6} />
      {items}
      {/* ventilação */}
      <mesh position={[0, -0.88, 0.81]}>
        <boxGeometry args={[2.7, 0.14, 0.02]} />
        <meshStandardMaterial color="#020617" metalness={0.3} roughness={0.8} />
      </mesh>
    </group>
  );
}

function OnuDevice({ device }: { device: DeviceCard }) {
  const los = device.status === 'critico';
  const leds: Array<[string, LedState]> = [['PWR', 'on'], ['PON', los ? 'off' : 'on'], ['LOS', los ? 'alarm' : 'off'], ['LAN', los ? 'off' : 'on'], ['WiFi', los ? 'off' : 'on']];
  return (
    <group position={[0, -0.1, 0]}>
      <RoundedBox args={[1.8, 0.32, 1.2]} radius={0.08} smoothness={4}>
        <meshStandardMaterial color="#e2e8f0" metalness={0.15} roughness={0.35} />
        <Edges color={EDGE} threshold={25} />
      </RoundedBox>
      {leds.map(([, st], i) => (
        <Led key={i} position={[-0.5 + i * 0.25, 0.05, 0.61]} state={st} size={[0.08, 0.035, 0.02]} />
      ))}
      {[-0.65, 0.65].map((x) => (
        <group key={x} position={[x, 0.16, -0.5]} rotation={[0.12, 0, x > 0 ? -0.12 : 0.12]}>
          <mesh position={[0, 0.45, 0]}>
            <cylinderGeometry args={[0.04, 0.05, 0.9, 16]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.2} roughness={0.4} />
            <Edges color={EDGE} threshold={40} />
          </mesh>
        </group>
      ))}
      {/* fibra chegando */}
      <mesh position={[0.6, -0.05, -0.75]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.6, 8]} />
        <meshStandardMaterial color={los ? '#f87171' : '#fbbf24'} emissive={los ? '#f87171' : '#fbbf24'} emissiveIntensity={0.9} toneMapped={false} />
      </mesh>
    </group>
  );
}

function ServerDevice({ device }: { device: DeviceCard }) {
  return (
    <group>
      <Chassis w={3.2} h={0.5} d={1.8} />
      {Array.from({ length: 8 }, (_, i) => (
        <group key={i} position={[-1.2 + i * 0.3, 0, 0.91]}>
          <mesh>
            <boxGeometry args={[0.26, 0.36, 0.02]} />
            <meshStandardMaterial color="#111c33" metalness={0.6} roughness={0.4} />
          </mesh>
          <Led position={[0.08, -0.13, 0.015]} state={device.status === 'critico' && i === 3 ? 'alarm' : 'on'} size={[0.03, 0.03, 0.01]} />
        </group>
      ))}
      <Led position={[1.35, 0.1, 0.91]} state={device.status === 'critico' ? 'alarm' : 'on'} size={[0.08, 0.04, 0.02]} />
    </group>
  );
}

function TransportDevice({ device }: { device: DeviceCard }) {
  return (
    <group>
      <Chassis w={3} h={0.66} d={1.6} />
      <PortRow count={Math.max(device.portas?.length ?? 4, 4)} width={1.6} y={0.05} z={0.81} ports={device.portas} device={device} tall />
      {/* bobina de fibra */}
      <mesh position={[1.1, 0, 0.84]} rotation={[0, 0, 0]}>
        <torusGeometry args={[0.18, 0.035, 12, 40]} />
        <meshStandardMaterial color="#fbbf24" emissive="#fbbf24" emissiveIntensity={0.7} toneMapped={false} />
      </mesh>
    </group>
  );
}

function GenericDevice({ device }: { device: DeviceCard }) {
  return (
    <group>
      <Chassis w={1.6} h={1.1} d={1.2} />
      <Led position={[0, 0, 0.61]} state={device.status === 'critico' ? 'alarm' : 'on'} size={[0.2, 0.06, 0.02]} />
    </group>
  );
}

/** Plano de varredura que sobe e desce pelo aparelho. */
function Scanner({ height }: { height: number }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.y = Math.sin(clock.elapsedTime * 0.9) * height * 0.55;
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[3.8, 2.4]} />
      <meshBasicMaterial color="#22d3ee" transparent opacity={0.07} depthWrite={false} />
    </mesh>
  );
}

/** Anel de status no piso, pulsando na cor do estado. */
function StatusRing({ status }: { status: DeviceStatus }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const s = 1 + (Math.sin(clock.elapsedTime * (status === 'critico' ? 4 : 1.6)) + 1) * 0.04;
    ref.current.scale.set(s, s, s);
  });
  return (
    <mesh ref={ref} position={[0, -0.74, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.9, 2.0, 96]} />
      <meshBasicMaterial color={STATUS_COLOR[status]} transparent opacity={0.65} toneMapped={false} />
    </mesh>
  );
}

function Model({ device }: { device: DeviceCard }) {
  const group = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (group.current) group.current.position.y = Math.sin(clock.elapsedTime * 1.2) * 0.03;
  });
  const body = useMemo(() => {
    switch (device.tipo) {
      case 'olt': return <OltDevice device={device} />;
      case 'onu': return <OnuDevice device={device} />;
      case 'switch': return <RackDevice device={device} units={1} />;
      case 'roteador': return <RackDevice device={device} units={2} router />;
      case 'servidor': return <ServerDevice device={device} />;
      case 'transporte': return <TransportDevice device={device} />;
      default: return <GenericDevice device={device} />;
    }
  }, [device]);
  const height = device.tipo === 'olt' ? 2.2 : device.tipo === 'generico' ? 1.2 : 0.8;
  return (
    <group ref={group}>
      {body}
      <Scanner height={height} />
    </group>
  );
}

export default function Device3D({ device }: { device: DeviceCard }) {
  const far = device.tipo === 'olt' ? 5.6 : device.tipo === 'onu' ? 3.6 : 4.6;
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [far * 0.55, far * 0.45, far], fov: 40 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: 'transparent' }}
    >
      <fog attach="fog" args={['#030712', 7, 14]} />
      <ambientLight intensity={0.7} />
      <hemisphereLight args={['#7dd3fc', '#0b1324', 0.6]} />
      <pointLight position={[4, 5, 4]} intensity={90} color="#7dd3fc" />
      <pointLight position={[-5, 2, -3]} intensity={30} color="#a78bfa" />
      <directionalLight position={[0, 6, 2]} intensity={0.6} />
      <Model device={device} />
      <StatusRing status={device.status} />
      <gridHelper args={[14, 28, '#155e75', '#0c2a3a']} position={[0, -0.75, 0]} />
      <OrbitControls autoRotate autoRotateSpeed={0.9} enablePan={false} minDistance={2.2} maxDistance={9} maxPolarAngle={Math.PI / 2.05} />
    </Canvas>
  );
}
