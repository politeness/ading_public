package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.dal.mapper.UserTagMapper;
import org.springframework.stereotype.Component;

/**
 * All regions get the online service. This only returns the region permission for the add-friend entry to clients; backend APIs don't block anything.
 * Under mainland China IPs, accounts tagged "mainland add-friend" can still add friends; Hong Kong, Macao and Taiwan are unrestricted.
 */
@Component
public class RegionPolicy {

    private final IpCityResolver resolver;
    private final UserTagMapper userTags;

    public RegionPolicy(IpCityResolver resolver, UserTagMapper userTags) {
        this.resolver = resolver;
        this.userTags = userTags;
    }

    public boolean canAddFriend(String ip, String userId) {
        if (!resolver.isMainlandChina(ip)) return true;
        return userId != null && userTags.hasTag(userId, UserTags.MAINLAND_ADD_FRIEND);
    }
}
