# Servidor de reconocimiento de tapas

Corre en Cloudflare Workers (plan gratuito) con Workers AI (10.000 neuronas por día sin cargo).

- Worker: `book-search-tapas` → https://book-search-tapas.guiidoosusmel.workers.dev
- Binding necesario: Workers AI con el nombre `AI`.
- Solo acepta pedidos desde https://guidosusmel.github.io y limita 40 fotos por hora por persona.
- Si se supera el uso gratuito del día, responde 429 y la app usa el lector local (Tesseract).

El código desplegado es `worker.js`.
