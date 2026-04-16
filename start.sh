#!/bin/bash
# Dashboard Grupo ATM — iniciar servidor SQLite
# Uso: bash start.sh

set -e

cd "$(dirname "$0")"

# Instala dependências se node_modules ainda não existe
if [ ! -d "node_modules" ]; then
  echo "📦 Instalando dependências..."
  npm install
fi

echo "🚀 Iniciando servidor na porta 3333..."
echo "   Dashboard: http://localhost:3333"
echo "   Para parar: Ctrl+C"
echo ""
node server.js
