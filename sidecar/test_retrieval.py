import tempfile, unittest
from pathlib import Path
from retrieval import RetrievalIndex

class RetrievalTests(unittest.TestCase):
    def test_indexes_and_returns_cited_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "launch.md").write_text("Orbit launch checklist includes privacy review and notarization.")
            index = RetrievalIndex(root / "orbit.db")
            self.assertEqual(index.index_roots([str(root)])["indexed"], 1)
            hits = index.search("privacy launch")
            self.assertEqual(hits[0].title, "launch.md")
            self.assertIn("privacy", hits[0].excerpt.lower())

if __name__ == "__main__": unittest.main()
