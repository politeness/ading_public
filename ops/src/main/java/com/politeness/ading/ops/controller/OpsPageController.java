package com.politeness.ading.ops.controller;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * Page entry. /ading/ops without a trailing slash must open too:
 * nginx 301s to the slashed URL, and this adds another fallback so direct access on port 8280 works as well.
 */
@Controller
public class OpsPageController {

    @GetMapping({"", "/"})
    public String index() {
        return "forward:/index.html";
    }
}
