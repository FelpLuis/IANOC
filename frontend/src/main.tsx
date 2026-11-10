import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthGate } from './components/AuthGate';
import { NiaTv } from './components/NiaTv';
import './index.css';

// /tv abre a NIA TV (tela de parede com as respostas das perguntas por voz).
const tv = /^\/tv\/?$/.test(window.location.pathname);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>{(user, logout) => (tv ? <NiaTv /> : <App user={user} onLogout={logout} />)}</AuthGate>
  </React.StrictMode>
);
