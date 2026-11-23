package com.ardia.phone

import android.app.Activity
import android.graphics.Color
import android.graphics.Rect
import android.graphics.RenderNode
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassStripTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private var lensesBuilt = 0
    private var shapesInLens = 0

    @Before
    fun lensStandsIn() {
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
        GlassShaders.reset()
        GlassShaders.makeRim = { throw IllegalArgumentException("no rim in this test") }
        GlassShaders.makeLens = { field ->
            lensesBuilt += 1
            shapesInLens = field.lenses.size
            android.graphics.RenderEffect.createOffsetEffect(0f, 0f)
        }
    }

    @After
    fun restore() {
        GlassShaders.reset()
        LookSwitch.forgetForTests()
    }

    private fun <T : View> T.at(left: Int, top: Int, width: Int, height: Int): T = apply { layout(left, top, left + width, top + height) }

    private fun onHardware(view: View) {
        val node = RenderNode("test")
        node.setPosition(0, 0, view.width.coerceAtLeast(1), view.height.coerceAtLeast(1))
        val canvas = node.beginRecording()
        try {
            assertTrue(canvas.isHardwareAccelerated)
            view.draw(canvas)
        } finally {
            node.endRecording()
        }
    }

    private class Scene(val root: FrameLayout, val source: FrostSourceView, val glasses: List<GlassView>)

    private fun scene(vararg boxes: Rect, sourceId: String = "strip-test"): Scene {
        val root = FrameLayout(activity)
        activity.setContentView(root)
        val source = FrostSourceView(activity, appContext).apply { this.sourceId = sourceId }
        source.addView(View(activity).apply { setBackgroundColor(Color.rgb(30, 120, 200)) })
        root.addView(source)
        val glasses = boxes.map { GlassView(activity, appContext).apply { this.source = sourceId; shape = "capsule" }.also(root::addView) }
        root.measure(View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(470, View.MeasureSpec.EXACTLY))
        root.at(0, 0, 320, 470)
        source.at(0, 0, 320, 470)
        source.getChildAt(0).at(0, 0, 320, 470)
        glasses.forEachIndexed { index, glass -> glass.at(boxes[index].left, boxes[index].top, boxes[index].width(), boxes[index].height()) }
        return Scene(root, source, glasses)
    }

    private fun live(scene: Scene) {
        scene.glasses.forEach(::onHardware)
        onHardware(scene.source)
        scene.glasses.forEach(::onHardware)
        scene.glasses.forEach { assertEquals(FrostPage.Path.Live, it.lastChoice?.path) }
    }

    private fun bar() = scene(Rect(10, 400, 54, 444), Rect(64, 400, 264, 444))

    @Test
    fun everyGlassOverOneSourceSharesOneBlurredStripThatCoversThemAll() {
        val scene = bar()
        live(scene)
        val strip = scene.source.stripsHeld.single()
        assertTrue("the strip reaches past the left glass's margin", strip.left <= 10)
        assertTrue("and past the right one's edge", strip.left + strip.width >= 264)
        assertTrue("it stays a strip near the bar, not the whole page", strip.top >= 300)
        assertEquals("both glasses' shapes go into the one lens", 2, shapesInLens)
        assertEquals(2, strip.lensed)
        assertSame(strip.node, strip.nodeFor(scene.glasses[0]))
        assertEquals(setOf(scene.glasses[0], scene.glasses[1]), strip.consumers.toSet())
        assertEquals(1, scene.source.stripStats.count)
    }

    @Test
    fun aGlassNearTheEdgeReusesTheClampedStripInsteadOfRecordingItOnEveryDraw() {
        val scene = scene(Rect(4, 4, 48, 48))
        live(scene)
        val strip = scene.source.stripsHeld.single()
        val key = strip.key
        val wanted = Rect()
        scene.glasses[0].stripNeed(scene.source, wanted)
        assertTrue("the glass's margin runs past the source's edge", wanted.left < 0 && wanted.top < 0)
        val recorded = strip.records
        val built = lensesBuilt
        for (frame in 1..5) scene.source.join(scene.glasses[0], key, 10_000L + frame * 8L, wanted)
        assertEquals("a still glass draws again without recording the strip", recorded, strip.records)
        assertEquals(built, lensesBuilt)
    }

    @Test
    fun theContentRefreshFollowsWhatMovesUnderTheGlassAndAsksForADrawOnlyWhenNothingElseWill() {
        val scene = bar()
        live(scene)
        val strip = scene.source.stripsHeld.single()
        val recorded = strip.records
        assertFalse("nothing under the glass changed", scene.source.refreshStrips(frameTime = 1_000L, drawPending = true))
        scene.source.contentMoved()
        assertTrue(scene.source.refreshStrips(frameTime = 1_000L, drawPending = true))
        assertFalse("once a frame however many ask", scene.source.refreshStrips(frameTime = 1_000L, drawPending = true))
        assertEquals(recorded + 1, strip.records)
        scene.glasses.forEach(::onHardware)
        assertFalse(scene.glasses.any { it.isDirty })
        scene.source.contentMoved()
        assertTrue("a trailing refresh with no draw coming", scene.source.refreshStrips(frameTime = 1_016L, drawPending = false))
        assertTrue("asks one glass to draw so the new sample reaches the screen", scene.glasses.count { it.isDirty } == 1)
        scene.source.release()
        assertEquals("releasing the source drops its strips", 0, scene.source.stripsHeld.size)
        assertEquals(0, scene.source.stripStats.count)
        scene.source.contentMoved()
        assertFalse(scene.source.refreshStrips(frameTime = 1_032L, drawPending = true))
    }

    @Test
    fun aGlassThatLeavesTakesItsLensWithItAndTheLastOneEvictsTheStrip() {
        val scene = bar()
        live(scene)
        val strip = scene.source.stripsHeld.single()
        scene.glasses[1].forgetLayer()
        assertEquals(setOf<FrostView>(scene.glasses[0]), strip.consumers.toSet())
        assertTrue(strip.stale)
        scene.source.contentMoved()
        assertTrue(scene.source.refreshStrips(frameTime = 2_000L, drawPending = true))
        assertEquals("the lens is rebuilt for the glass still there", 1, strip.lensed)
        assertEquals(1, shapesInLens)
        assertTrue("and the strip shrinks to it", strip.left + strip.width < 264)
        scene.glasses[0].forgetLayer()
        assertEquals(0, scene.source.stripsHeld.size)
        assertEquals(0, scene.source.stripStats.count)
    }

    @Test
    fun aGlassThatMovesToAnotherKeyLeavesItsOldStripBehind() {
        val scene = bar()
        live(scene)
        val old = scene.source.stripsHeld.single()
        val wanted = Rect()
        val key = scene.glasses[0].stripNeed(scene.source, wanted)!!
        val denser = key.copy(blurPx = key.blurPx * 2f, scale = FrostScale.of(key.blurPx * 2f))
        scene.source.join(scene.glasses[0], denser, 5_000L, wanted)
        scene.source.join(scene.glasses[1], denser, 5_000L, wanted)
        assertEquals("a density change leaves no strip for the old key", listOf(denser), scene.source.stripsHeld.map { it.key })
        assertEquals(0, old.width)
    }

    @Test
    fun theFirstTwelveGlassesByAgeHoldTheLensSlotsAndTheThirteenthSamplesThePlainBlur() {
        val boxes = (0 until 13).map { index -> Rect(4 + (index % 6) * 52, 40 + (index / 6) * 60, 4 + (index % 6) * 52 + 44, 40 + (index / 6) * 60 + 44) }
        val scene = scene(*boxes.toTypedArray())
        scene.glasses.reversed().forEach(::onHardware)
        onHardware(scene.source)
        scene.glasses.reversed().forEach(::onHardware)
        val strip = scene.source.stripsHeld.single()
        assertEquals(LiquidGlassRules.MAX_LENSES, strip.lensed)
        val youngest = scene.glasses.maxBy { it.number }
        assertTrue("an overflow glass draws a plain blur, not a neighbour's refraction", strip.holdsPlain)
        assertNotSame(strip.node, strip.nodeFor(youngest))
        scene.glasses.filter { it !== youngest }.forEach { assertSame(strip.node, strip.nodeFor(it)) }
        scene.glasses.first { it !== youngest }.forgetLayer()
        scene.source.contentMoved()
        assertTrue(scene.source.refreshStrips(frameTime = 3_000L, drawPending = true))
        assertSame("a freed slot goes to the glass that was waiting", strip.node, strip.nodeFor(youngest))
        assertFalse(strip.holdsPlain)
    }

    @Test
    fun aReplacedSourceRedrawsItsGlassesAndIsAskedToRecordForThem() {
        val first = bar()
        live(first)
        first.glasses.forEach(::onHardware)
        first.root.removeView(first.source)
        assertTrue("the glasses drop the discarded strip at once", first.glasses.all { it.isDirty })
        first.glasses.forEach(::onHardware)
        assertEquals(FrostPage.NO_SOURCE, first.glasses[0].lastChoice?.reason)
        assertTrue("a glass with no source still wants one", first.glasses[0].wantsSource())
        val replacement = FrostSourceView(activity, appContext).apply { sourceId = "strip-test" }
        replacement.addView(View(activity).apply { setBackgroundColor(Color.RED) })
        first.root.addView(replacement, 0)
        replacement.at(0, 0, 320, 470)
        replacement.getChildAt(0).at(0, 0, 320, 470)
        assertTrue("the new source asks its glasses to draw again", first.glasses.all { it.isDirty })
        assertTrue(FrostSources.anyFrostCanBlur("strip-test"))
        onHardware(replacement)
        assertTrue("and records for them on its first draw", replacement.isRecording)
    }
}
