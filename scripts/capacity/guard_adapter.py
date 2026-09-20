"""Keep the real model guard loaded with a disabled, synthetic local budget."""
import os
from pathlib import Path
import threading
from http.server import ThreadingHTTPServer
from generation_guard import Handler

if not Path('/capacity-test-image').is_file() or os.environ.get('CAPACITY_TEST_ONLY') != 'synthetic-no-network':
    raise RuntimeError('Isolated test image required')
server = ThreadingHTTPServer(('127.0.0.1', 8002), Handler)
server.database = dict(host='127.0.0.1', dbname='quizforge', user='quizforge_generation',
                       password='synthetic-capacity-only', sslmode='verify-full',
                       sslrootcert='/tmp/capacity/server.crt', autocommit=True, connect_timeout=5)
server.slots = threading.BoundedSemaphore(8)
server.serve_forever()
