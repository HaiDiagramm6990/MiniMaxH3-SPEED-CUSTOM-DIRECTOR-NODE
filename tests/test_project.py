import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("director_project", pathlib.Path(__file__).parents[1] / "project.py")
project = importlib.util.module_from_spec(spec)
spec.loader.exec_module(project)


class TimelineTests(unittest.TestCase):
    def test_quantization_and_seed_inheritance(self):
        raw = project.default_project()
        first = raw["scenes"][0]
        first["overrides"] = {"frames": 23, "seed": "42"}
        first["passes"].append({"id": "1" * 32, "mode": "extend", "overrides": {"frames": 125}})
        beats = project.validate_project(raw)["scenes"][0]["passes"]
        self.assertEqual([(beat["settings"]["frames"], beat["settings"]["seed"]) for beat in beats],
                         [(39, "42"), (141, "43")])
        self.assertEqual(first["overrides"]["frames"], 23)

    def test_no_fixed_scene_count(self):
        raw = project.default_project()
        raw["scenes"] *= 180
        raw["scenes"] = [scene | {"id": f"{index:032x}"} for index, scene in enumerate(raw["scenes"])]
        self.assertEqual(len(project.validate_project(raw)["scenes"]), 180)

    def test_first_transition_needs_source(self):
        raw = project.default_project()
        raw["scenes"][0]["transition"] = "continuous"
        with self.assertRaisesRegex(ValueError, "first scene"):
            project.validate_project(raw)

    def test_asset_name_is_an_opaque_id(self):
        raw = project.default_project()
        raw["scenes"][0]["references"] = ["../../outside.png"]
        with self.assertRaisesRegex(ValueError, "library"):
            project.validate_project(raw)

    def test_overrides_must_match_the_schema(self):
        raw = project.default_project()
        raw["scenes"][0]["passes"][0]["overrides"] = {"stepz": 8}
        with self.assertRaisesRegex(ValueError, "stepz"):
            project.validate_project(raw)

    def test_render_action_rejects_unknown_scene(self):
        action = json.dumps({"scene": "1" * 32, "nonce": "2" * 32})
        with self.assertRaisesRegex(ValueError, "missing"):
            project.parse_action(action, ["3" * 32])

    def test_selected_resume_preserves_the_current_revision(self):
        scene_id = "1" * 32
        action = project.parse_action(json.dumps({"scene": scene_id, "mode": "resume"}), [scene_id])
        self.assertIsNone(action["nonce"])

    def test_example_project_validates(self):
        sample = pathlib.Path(__file__).parents[1] / "examples" / "Paper Boat.h3director.json"
        raw = json.loads(sample.read_text(encoding="utf-8"))["project"]
        self.assertEqual(len(project.validate_project(raw)["scenes"]), 2)

    def test_generation_defaults_preserve_existing_projects(self):
        raw = project.default_project()
        checked = project.validate_project(raw)
        self.assertEqual(checked["scenes"][0]["passes"][0]["generation"], "legacy")
        self.assertNotIn("generation", raw["scenes"][0])

    def test_pass_mode_and_media_override(self):
        raw = project.default_project()
        scene = raw["scenes"][0]
        scene["generation"] = "T2VA"
        scene["passes"][0].update(generation="L2VA", media={"last_frame": "a" * 32 + ".png"})
        checked = project.validate_project(raw)["scenes"][0]["passes"][0]
        self.assertEqual(checked["generation"], "L2VA")
        self.assertEqual(checked["media"]["last_frame"], "a" * 32 + ".png")

    def test_reference_video_rejects_wrong_media_type(self):
        raw = project.default_project()
        raw["scenes"][0].update(generation="REF", videos=[{"asset": "a" * 32 + ".jpg"}])
        with self.assertRaisesRegex(ValueError, "reference video"):
            project.validate_project(raw)

    def test_old_projects_default_to_preview_off(self):
        raw = project.default_project()
        del raw["live_preview"]
        self.assertFalse(project.validate_project(raw)["live_preview"]["enabled"])

    def test_memory_cleanup_defaults_on_and_can_be_disabled(self):
        raw = project.default_project()
        del raw["auto_cleanup"]
        self.assertTrue(project.validate_project(raw)["auto_cleanup"])
        raw["auto_cleanup"] = False
        self.assertFalse(project.validate_project(raw)["auto_cleanup"])
        raw["auto_cleanup"] = "false"
        with self.assertRaisesRegex(ValueError, "Auto memory cleanup"):
            project.validate_project(raw)

    def test_preview_settings_are_bounded(self):
        raw = project.default_project()
        raw["live_preview"] = {"enabled": True, "resolution": 192, "frames": 6, "fps": 12}
        preview = project.validate_project(raw)["live_preview"]
        self.assertEqual((preview["resolution"], preview["jpeg_quality"], preview["frames"], preview["fps"]),
                         (192, 75, 6, 12))
        raw["live_preview"]["frames"] = 1000
        with self.assertRaisesRegex(ValueError, "Live preview frames"):
            project.validate_project(raw)


if __name__ == "__main__":
    unittest.main()
