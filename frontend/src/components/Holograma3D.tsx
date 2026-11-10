/**
 * Holograma 3D da NIA (Three.js): núcleo luminoso, malha geodésica em wireframe, anéis
 * orbitando e partículas — fundo da NIA TV quando a resposta não tem topologia, equipamento
 * ou dashboard, e enquanto a NIA pensa (gira mais rápido).
 */
import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Sparkles, Stars } from '@react-three/drei';
import type { Group, Mesh } from 'three';

function Nucleo({ pensando }: { pensando: boolean }) {
  const malha = useRef<Mesh>(null);
  const aneis = useRef<Group>(null);
  const nucleo = useRef<Mesh>(null);
  useFrame((_, dt) => {
    const v = pensando ? 2.4 : 1;
    if (malha.current) { malha.current.rotation.y += dt * 0.25 * v; malha.current.rotation.x += dt * 0.08 * v; }
    if (aneis.current) { aneis.current.rotation.z += dt * 0.35 * v; aneis.current.rotation.y -= dt * 0.18 * v; }
    if (nucleo.current) { const s = 1 + Math.sin(performance.now() / (pensando ? 180 : 600)) * 0.06; nucleo.current.scale.setScalar(s); }
  });
  return (
    <Float speed={1.2} rotationIntensity={0.25} floatIntensity={0.6}>
      <mesh ref={nucleo}>
        <sphereGeometry args={[0.62, 48, 48]} />
        <meshStandardMaterial color="#12baea" emissive="#12baea" emissiveIntensity={1.6} roughness={0.2} metalness={0.1} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.95, 32, 32]} />
        <meshBasicMaterial color="#3d22f0" transparent opacity={0.12} />
      </mesh>
      <mesh ref={malha}>
        <icosahedronGeometry args={[1.55, 2]} />
        <meshBasicMaterial color="#5fd2f3" wireframe transparent opacity={0.35} />
      </mesh>
      <group ref={aneis}>
        <mesh rotation={[Math.PI / 2.4, 0, 0]}>
          <torusGeometry args={[2.15, 0.012, 8, 160]} />
          <meshBasicMaterial color="#c874f8" transparent opacity={0.8} />
        </mesh>
        <mesh rotation={[Math.PI / 1.7, 0.6, 0]}>
          <torusGeometry args={[2.45, 0.01, 8, 160]} />
          <meshBasicMaterial color="#12baea" transparent opacity={0.6} />
        </mesh>
        <mesh rotation={[0.3, Math.PI / 2.2, 0]}>
          <torusGeometry args={[2.75, 0.008, 8, 160]} />
          <meshBasicMaterial color="#a40ae8" transparent opacity={0.45} />
        </mesh>
      </group>
    </Float>
  );
}

export default function Holograma3D({ pensando = false }: { pensando?: boolean }) {
  return (
    <Canvas dpr={[1, 1.75]} camera={{ position: [0, 0.3, 6.2], fov: 45 }} gl={{ antialias: true, alpha: true }}>
      <ambientLight intensity={0.5} />
      <pointLight position={[4, 4, 4]} intensity={60} color="#8ddcf5" />
      <pointLight position={[-4, -2, 2]} intensity={40} color="#c874f8" />
      <Stars radius={50} depth={25} count={1400} factor={3} fade speed={0.5} />
      <Sparkles count={pensando ? 90 : 50} scale={[7, 5, 4]} size={2.2} speed={pensando ? 1.4 : 0.4} color="#9be3f8" />
      <Nucleo pensando={pensando} />
    </Canvas>
  );
}
