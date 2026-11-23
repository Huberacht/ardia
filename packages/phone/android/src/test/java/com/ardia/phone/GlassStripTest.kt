package com.ardia.phone

import android.app.Activity
import android.graphics.Color
import android.graphics.RenderNode
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertEquals
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

    @Before
    fun shadersStayOut() {
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
        GlassShaders.reset()
        GlassShaders.makeRim = { throw IllegalArgumentException("no rim in this test") }
        GlassShaders.makeLens = { throw IllegalArgumentException("no lens in this test") }
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

    @Test
    fun everyGlassOverOneSourceSharesOneBlurredStripThatCoversThemAll() {
        val root = FrameLayout(activity)
        activity.setContentView(root)
        val source = FrostSourceView(activity, appContext).apply { sourceId = "strip-test" }
        source.addView(View(activity).apply { setBackgroundColor(Color.rgb(30, 120, 200)) })
        val tabs = GlassView(activity, appContext).apply { this.source = "strip-test"; shape = "circle" }
        val address = GlassView(activity, appContext).apply { this.source = "strip-test"; shape = "capsule" }
        root.addView(source)
        root.addView(tabs)
        root.addView(address)
        root.measure(View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(470, View.MeasureSpec.EXACTLY))
        root.at(0, 0, 320, 470)
        source.at(0, 0, 320, 470)
        source.getChildAt(0).at(0, 0, 320, 470)
        tabs.at(10, 400, 44, 44)
        address.at(64, 400, 200, 44)
        onHardware(tabs)
        onHardware(address)
        onHardware(source)
        assertTrue("the source records once a glass wants it", source.isRecording)
        val before = LookActivity.stripRecords
        onHardware(tabs)
        onHardware(address)
        assertEquals(FrostPage.Path.Live, tabs.lastChoice?.path)
        assertEquals(FrostPage.Path.Live, address.lastChoice?.path)
        assertEquals("one strip for both glasses in one frame", 1L, LookActivity.stripRecords - before)
        val strips = source.stripsHeld.toList()
        assertEquals(1, strips.size)
        val strip = strips.single()
        assertTrue("the strip reaches past the left glass's margin", strip.left <= 10)
        assertTrue("and past the right one's edge", strip.left + strip.width >= 264)
        assertTrue("it stays a strip near the bar, not the whole page", strip.top >= 300)
        assertTrue(tabs.holdsLayer && address.holdsLayer)
        source.release()
        assertEquals("releasing the source drops its strips", 0, source.stripsHeld.size)
    }
}
